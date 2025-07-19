import * as pulumi from "@pulumi/pulumi";
import { Output } from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

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
  stages: BuildStage[];
  codestarconnectionArn: Output<string>; // ARN de la conexión de CodeStar
  crossAccountDeploymentRoleName?: string;
  pulumiBackendBucketName?: string;
}


export class AwsPipeline extends pulumi.ComponentResource {

  public readonly codeBuildProjects: Record<string, aws.codebuild.Project> = {};
  public readonly codeBuildRole: aws.iam.Role;
  public readonly pipelineRole: aws.iam.Role;
  public readonly stages: aws.types.input.codepipeline.PipelineStage[] = [];
  public readonly artifactBucket: aws.s3.Bucket;

  constructor(name: string, args: PipelineArgs, opts?: pulumi.ComponentResourceOptions, nameCallback?: (resourceName: string) => string) {
    super("pipeline-component:index:Pipeline", name, args, opts);
    const resourceName = nameCallback ?? ((r) => `${name}-${r}`)
    this.artifactBucket = this.createArtifactBucket(resourceName('bucket-artifacts'));
    args.crossAccountDeploymentRoleName ??= "CrossAccountDeploymentRole";

    // Crear roles IAM
    this.codeBuildRole = this.createRole(resourceName("role-codebuild"), "codebuild.amazonaws.com");
    this.pipelineRole = this.createRole(resourceName("role-pipeline"), "codepipeline.amazonaws.com");
    // Adjuntar políticas a los roles
    this.attachPolicy(resourceName("codebuild-policy-attachment"), this.codeBuildRole, aws.iam.ManagedPolicies.AdministratorAccess);
    this.attachPolicy(resourceName("pipeline-policy-attachment"), this.pipelineRole, aws.iam.ManagedPolicies.AdministratorAccess);

    // Permitir acceso cross-account
    const uniqueAccounts = new Set<string>();
    for (const stage of args.stages) {
      if (stage.targetAccountId?.length) {
        stage.targetAccountId.forEach(accountId => uniqueAccounts.add(accountId));
      }
    }

    // Si hay cuentas de destino únicas, otorgar acceso cross-account
    if (uniqueAccounts.size > 0) {
      this.grantCrossAccountAccess(
        resourceName("assume-crossaccount-role"),
        Array.from(uniqueAccounts),
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
      this.codeBuildProjects[stage.name] = this.createCodeBuildProject(resourceName(`codebuild-${args.name}-${stage.name}`), stage);
    }

    // Pipeline Stages
    for (const stage of args.stages) {
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

    this.registerOutputs({
      arn: pipeline.arn,
      name: pipeline.name,
    });
  }

  private createArtifactBucket(name: string): aws.s3.Bucket {
    return new aws.s3.Bucket(name);
  }

  private createRole(name: string, servicePrincipal: string): aws.iam.Role {
    return new aws.iam.Role(name, {
      name: name,
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: servicePrincipal }),
    });
  }

  private attachPolicy(name: string, role: aws.iam.Role, policyArn: string): aws.iam.RolePolicyAttachment {
    return new aws.iam.RolePolicyAttachment(name, {
      role,
      policyArn,
    });
  }

  private createCodeBuildProject(name: string, stage: PipelineArgs["stages"][0]): aws.codebuild.Project {

    return new aws.codebuild.Project(name, {
      name,
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
    name: string,
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

    new aws.iam.RolePolicy(name, {
      name,
      role: this.codeBuildRole.name,
      policy: JSON.stringify(assumeRolePolicy),
    });

    // Permitir acceso al bucket de Pulumi backend
    if (pulumiBackendBucketName)
      new aws.s3.BucketPolicy(
        `${pulumiBackendBucketName}-crossaccount-access`,
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