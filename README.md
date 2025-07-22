# Pulumi CI/CD Pipeline for AWS with Cross-Account Support

This package provides a reusable Pulumi component to define and deploy AWS CodePipeline pipelines with support for custom naming conventions, cross-account deployments, and flexible build stages.

## Features

- Custom naming through a `nameCallback` function.
- Support for CodeStar Connections.
- Optional cross-account role configuration.
- S3 backend bucket support for Pulumi state.
- Easy extensibility and reusable structure.

## Usage

```ts
import { AwsPipeline } from "@myorg/pipeline";

const pipeline = new AwsPipeline("my-pipeline", {
  name: "my-pipeline",
  fullRepositoryId: "myorg/myrepo",
  branch: "main",
  codestarconnectionArn: connection.arn,
  stages: [...],
  nameCallback: (base) => `myorg-${base}`,
});
```

## PipelineArgs

| Name | Type | Description |
|------|------|-------------|
| name | string | Base name of the pipeline |
| fullRepositoryId | string | Repository identifier (e.g., `org/repo`) |
| branch | string | Branch to track |
| stages | BuildStage[] | List of CodeBuild stages |
| codestarconnectionArn | Output<string> | ARN of the CodeStar Connection |
| crossAccountDeploymentRoleName | string (optional) | IAM Role name for cross-account deployments |
| pulumiBackendBucketName | string (optional) | S3 bucket for Pulumi backend |
| nameCallback | (resourceName: string) => string (optional) | Function to customize naming |

## License

MIT
