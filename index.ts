import * as pulumi from "@pulumi/pulumi";
import { Output } from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

export interface EnvironmentVariable {
  name: string;
  value: string;
  type?: "PLAINTEXT" | "PARAMETER_STORE" | "SECRETS_MANAGER";
}

export interface BuildStage {
  name: string;
  manualApproval?: boolean;
  targetAccountId?: string[];
  build: {
    buildspec: string;
    environmentVariables: EnvironmentVariable[];
  };
}

export interface PipelineArgs {
  name: string;
  fullRepositoryId: string;
  branch: string;
  stages: BuildStage[];
  codestarconnectionArn: Output<string>; // ARN de la conexión de CodeStar
  crossAccountDeploymentRoleName?: string;
  pulumiBackendBucketName?: string;
  nameCallback?: (resourceName: string) => string;
}


export class AwsPipeline extends pulumi.ComponentResource {

  public readonly codeBuildProjects: Record<string, aws.codebuild.Project> = {};
  public readonly codeBuildRole: aws.iam.Role;
  public readonly pipelineRole: aws.iam.Role;
  public readonly stages: aws.types.input.codepipeline.PipelineStage[] = [];
  public readonly uniqueTargetAccounts = new Set<string>();
  public readonly artifactBucket: aws.s3.Bucket = this.createArtifactBucket();
  private readonly name: (resourceName: string) => string;

  constructor(name: string, args: PipelineArgs, opts?: pulumi.ComponentResourceOptions) {
    super("pipeline-component:index:Pipeline", name, args, opts);
    this.name = args.nameCallback ?? ((r) => `${name}-${r}`);

    args.crossAccountDeploymentRoleName ??= "CrossAccountDeploymentRole";

    // Crear roles IAM
    this.codeBuildRole = this.createRole("codebuild", "codebuild.amazonaws.com");
    this.pipelineRole = this.createRole("pipeline", "codepipeline.amazonaws.com");
    // Adjuntar políticas a los roles
    this.attachPolicy("codebuild", this.codeBuildRole, aws.iam.ManagedPolicies.AdministratorAccess);
    this.attachPolicy("pipeline", this.pipelineRole, aws.iam.ManagedPolicies.AdministratorAccess);

    // Permitir acceso cross-account
    for (const stage of args.stages) {
      if (stage.targetAccountId?.length) {
        stage.targetAccountId.forEach(accountId => this.uniqueTargetAccounts.add(accountId));
      }
    }
    // Si hay cuentas de destino únicas, otorgar acceso cross-account
    if (this.uniqueTargetAccounts.size > 0) {
      this.grantCrossAccountAccess(
        Array.from(this.uniqueTargetAccounts),
        args.crossAccountDeploymentRoleName,
        args.pulumiBackendBucketName
      );
    }

    this.stages.push({
      name: "Source",
      actions: [
        {
          name: "SourceAction",
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
        },
      ],
    });

    // Build Projects
    for (const stage of args.stages) {
      this.codeBuildProjects[stage.name] = this.createCodeBuildProject(args.name, stage);
    }

    // Pipeline Stages
    for (const stage of args.stages) {
      this.stages.push(this.createPipelineStage(stage));
    }

    const pipeline = new aws.codepipeline.Pipeline(this.name(args.name), {
      name: this.name(args.name),
      roleArn: this.pipelineRole.arn,
      artifactStores: [
        {
          location: this.artifactBucket.bucket,
          type: "S3",
        },
      ],
      stages: this.stages,
    });

    this.registerOutputs({
      arn: pipeline.arn,
      name: pipeline.name,
    });
  }

  private createArtifactBucket(): aws.s3.Bucket {
    return new aws.s3.Bucket(this.name(`bucket-artifacts`));
  }

  private createRole(nameSuffix: string, servicePrincipal: string): aws.iam.Role {
    return new aws.iam.Role(this.name(`role-${nameSuffix}`), {
      name: this.name(`role-${nameSuffix}`),
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: servicePrincipal }),
    });
  }

  private attachPolicy(prefix: string, role: aws.iam.Role, policyArn: string): aws.iam.RolePolicyAttachment {
    return new aws.iam.RolePolicyAttachment(this.name(`${prefix}-policy-attachment`), {
      role,
      policyArn,
    });
  }

  private createCodeBuildProject(prefix: string, stage: PipelineArgs["stages"][0]): aws.codebuild.Project {
    const projectName = this.name(`codebuild-${prefix}-${stage.name}`);

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
        environmentVariables: stage.build.environmentVariables.map(env => ({
          name: env.name,
          value: env.value,
          type: env.type ?? "PLAINTEXT",
        })),
      },
      serviceRole: this.codeBuildRole.arn,
    });
  }

  private createPipelineStage(stage: PipelineArgs["stages"][0]): aws.types.input.codepipeline.PipelineStage {
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

    new aws.iam.RolePolicy(this.name("assume-crossaccount-role"), {
      name: this.name("assume-crossaccount-role"),
      role: this.codeBuildRole.name,
      policy: JSON.stringify(assumeRolePolicy),
    });

    // Permitir acceso al bucket de Pulumi backend
    if (pulumiBackendBucketName)
      new aws.s3.BucketPolicy(
        this.name("pulumi-crossaccount-access"),
        {
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
          })

        }
      );
  }

}