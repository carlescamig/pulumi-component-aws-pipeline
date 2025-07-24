import * as pulumi from "@pulumi/pulumi";
import { Output } from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

type ResourceName = (resourceName: string) => string;

interface EnvironmentVariable {
  name: string;
  value: string;
  type?: string; // Puede ser "PLAINTEXT" o "PARAMETER_STORE"
}
export interface BuildConfig {
  buildspec: string;
  environmentVariables: EnvironmentVariable[];
}

export interface BuildStage {
  name: string;
  manualApproval?: boolean;
  targetAccountId?: string[];
  build: BuildConfig; // Usar el nuevo tipo nombrado
}

export interface PipelineArgs {
  name: string;
  fullRepositoryId: string;
  branch: string;
  sourceStageActions?: aws.types.input.codepipeline.PipelineStageAction[];
  buildStages: BuildStage[];
  codestarconnectionArn: Output<string>; // ARN de la conexión de CodeStar
  crossAccountDeploymentRoleName?: string;
  pulumiBackendBucketName?: string;
}

export class AwsPipeline extends pulumi.ComponentResource {
  public readonly arn: Output<string>;
  public readonly name: Output<string>;
  public readonly crossAccountInstructions: pulumi.Output<
    Record<string, string>
  >;
  public readonly codeBuildProjects: Record<string, aws.codebuild.Project> = {};
  public readonly codeBuildRole: aws.iam.Role;
  public readonly pipelineRole: aws.iam.Role;
  public readonly stages: aws.types.input.codepipeline.PipelineStage[] = [];
  public readonly artifactBucket: aws.s3.Bucket;

  constructor(
    name: string,
    args: PipelineArgs,
    opts?: pulumi.ComponentResourceOptions,
    nameCallback?: (resourceName: string) => string
  ) {
    super("pipeline-component:index:Pipeline", name, args, opts);

    const resourceName = nameCallback ?? ((r) => `${name}-${r}`);
    this.artifactBucket = this.createArtifactBucket(resourceName);
    args.crossAccountDeploymentRoleName ??= "CrossAccountDeploymentRole";

    // Crear roles IAM
    this.codeBuildRole = this.createRole(
      "codebuild",
      "codebuild.amazonaws.com",
      resourceName
    );
    this.pipelineRole = this.createRole(
      "pipeline",
      "codepipeline.amazonaws.com",
      resourceName
    );
    // Adjuntar políticas a los roles
    this.attachPolicy(
      "codebuild",
      this.codeBuildRole,
      aws.iam.ManagedPolicy.AdministratorAccess,
      resourceName
    );
    this.attachPolicy(
      "pipeline",
      this.pipelineRole,
      aws.iam.ManagedPolicy.AdministratorAccess,
      resourceName
    );

    // Permitir acceso cross-account
    const uniqueAccounts = new Set<string>();
    for (const stage of args.buildStages) {
      if (stage.targetAccountId?.length) {
        stage.targetAccountId.forEach((accountId) =>
          uniqueAccounts.add(accountId)
        );
      }
    }

    // Si hay cuentas de destino únicas, otorgar acceso cross-account
    if (uniqueAccounts.size > 0) {
      this.grantCrossAccountAccess(
        Array.from(uniqueAccounts),
        args.crossAccountDeploymentRoleName,
        resourceName,
        args.pulumiBackendBucketName
      );
    }
    
    // Source stage actions
    this.createSourceStage(args);

    // Build Projects
    for (const stage of args.buildStages) {
      this.codeBuildProjects[stage.name] = this.createCodeBuildProject(
        args.name,
        stage,
        resourceName
      );
    }

    // Pipeline Stages
    for (const stage of args.buildStages) {
      this.stages.push(this.createPipelineStage(stage));
    }

    const pipeline = new aws.codepipeline.Pipeline(resourceName(args.name), {
      name: resourceName(args.name),
      roleArn: this.pipelineRole.arn,
      artifactStores: [
        {
          location: this.artifactBucket.bucket,
          type: "S3",
        },
      ],
      stages: this.stages,
    });

    this.crossAccountInstructions = pulumi.output(
      pulumi.output(aws.getCallerIdentity({})).apply((identity) => {
        const trustedAccountId = identity.accountId;
        const entries: Record<string, string> = {};

        for (const accountId of uniqueAccounts) {
          const roleName = args.crossAccountDeploymentRoleName!;
          const assumePolicy = {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: {
                  AWS: `arn:aws:iam::${trustedAccountId}:root`,
                },
                Action: "sts:AssumeRole",
              },
            ],
          };

          entries[`create role at ${accountId}`] = [
            `aws iam create-role --role-name ${roleName}`,
            `--assume-role-policy-document '${JSON.stringify(assumePolicy)}'`,
            `--description "Role to be assumed by CodeBuild pipeline from account ${trustedAccountId}"`,
          ].join(" ");
          entries[`attach role policy`] = [
            `aws iam attach-role-policy`,
            `--role-name ${roleName}`,
            `--policy-arn arn:aws:iam::aws:policy/AdministratorAccess`,
          ].join(" ");
        }

        return entries;
      })
    );
    this.arn = pipeline.arn;
    this.name = pipeline.name;

    this.registerOutputs({
      arn: pipeline.arn,
      name: pipeline.name,
      crossAccountInstructions: this.crossAccountInstructions,
    });
  }

  private createSourceStage(args: PipelineArgs) {
    const baseSourceAction = {
      category: "Source",
      owner: "AWS",
      provider: "CodeStarSourceConnection",
      version: "1",
      outputArtifacts: ["source_output"],
      configuration: {
        ConnectionArn: args.codestarconnectionArn,
        FullRepositoryId: args.fullRepositoryId,
        BranchName: args.branch,
        DetectChanges: "true",
      },
    };

    const sourceActions = (
      args.sourceStageActions?.length
        ? args.sourceStageActions
        : [
            {
              name: "SourceAction",
              category: "Source",
              owner: "AWS",
              provider: "CodeStarSourceConnection",
              version: "1",
              outputArtifacts: ["source_output"],
              configuration: {},
            },
          ]
    ).map((action, index) => ({
      ...baseSourceAction,
      ...action,
      name: action.name ?? `SourceAction-${index}`,
      configuration: {
        ...baseSourceAction.configuration,
        ...action.configuration,
      },
    }));

    this.stages.push({ name: "Source", actions: sourceActions });
  }

  private createArtifactBucket(resourceName: ResourceName): aws.s3.Bucket {
    return new aws.s3.Bucket(resourceName(`bucket-artifacts`));
  }

  private createRole(
    nameSuffix: string,
    servicePrincipal: string,
    resourceName: ResourceName
  ): aws.iam.Role {
    return new aws.iam.Role(resourceName(`role-${nameSuffix}`), {
      name: resourceName(`role-${nameSuffix}`),
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: servicePrincipal,
      }),
    });
  }

  private attachPolicy(
    prefix: string,
    role: aws.iam.Role,
    policyArn: string,
    resourceName: ResourceName
  ): aws.iam.RolePolicyAttachment {
    return new aws.iam.RolePolicyAttachment(
      resourceName(`${prefix}-policy-attachment`),
      {
        role,
        policyArn,
      }
    );
  }

  private createCodeBuildProject(
    prefix: string,
    stage: PipelineArgs["buildStages"][0],
    resourceName: ResourceName
  ): aws.codebuild.Project {
    const projectName = resourceName(`codebuild-${prefix}-${stage.name}`);

    return new aws.codebuild.Project(projectName, {
      name: projectName,
      source: {
        type: "CODEPIPELINE",
        buildspec: stage.build.buildspec,
      },
      artifacts: {
        type: "CODEPIPELINE",
      },
      environment: {
        computeType: "BUILD_GENERAL1_SMALL",
        image: "aws/codebuild/standard:7.0",
        type: "LINUX_CONTAINER",
        environmentVariables: stage.build.environmentVariables.map((env) => ({
          name: env.name,
          value: env.value,
          type: env.type ?? "PLAINTEXT",
        })),
      },
      serviceRole: this.codeBuildRole.arn,
    });
  }

  private createPipelineStage(
    stage: PipelineArgs["buildStages"][0]
  ): aws.types.input.codepipeline.PipelineStage {
    let runOrder = 1;
    const actions: aws.types.input.codepipeline.PipelineStageAction[] = [];

    // Approval Step (optional)
    if (stage.manualApproval) {
      actions.push({
        name: `ManualApproval-${stage.name}`,
        category: "Approval",
        owner: "AWS",
        provider: "Manual",
        version: "1",
        configuration: {
          CustomData: `Approve deployment to ${stage.name}`,
        },
        runOrder: runOrder++,
      });
    }

    // Build Step
    actions.push({
      name: `Build-${stage.name}`,
      category: "Build",
      owner: "AWS",
      provider: "CodeBuild",
      version: "1",
      inputArtifacts: ["source_output"],
      outputArtifacts: [`build_output_${stage.name}`],
      configuration: {
        ProjectName: this.codeBuildProjects[stage.name].name,
      },
      runOrder: runOrder++,
    });

    return {
      name: `Deploy-${stage.name}`,
      actions,
    };
  }

  private grantCrossAccountAccess(
    targetAccountIds: string[],
    crossAccountRoleName: string,
    resourceName: ResourceName,
    pulumiBackendBucketName?: string
  ) {
    const assumeRolePolicy = {
      Version: "2012-10-17",
      Statement: targetAccountIds.map((accountId) => ({
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Resource: `arn:aws:iam::${accountId}:role/${crossAccountRoleName}`,
      })),
    };

    new aws.iam.RolePolicy(resourceName("assume-crossaccount-role"), {
      name: resourceName("assume-crossaccount-role"),
      role: this.codeBuildRole.name,
      policy: JSON.stringify(assumeRolePolicy),
    });

    // Permitir acceso al bucket de Pulumi backend
    if (pulumiBackendBucketName)
      new aws.s3.BucketPolicy(resourceName("pulumi-crossaccount-access"), {
        bucket: pulumiBackendBucketName,
        policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: targetAccountIds.map((accountId) => ({
            Sid: `AllowAccessFrom-${accountId}`,
            Effect: "Allow",
            Principal: {
              AWS: `arn:aws:iam::${accountId}:role/${crossAccountRoleName}`,
            },
            Action: [
              "s3:GetObject",
              "s3:PutObject",
              "s3:DeleteObject",
              "s3:ListBucket",
            ],
            Resource: [
              `arn:aws:s3:::${pulumiBackendBucketName}`,
              `arn:aws:s3:::${pulumiBackendBucketName}/*`,
            ],
          })),
        }),
      });
  }
}
