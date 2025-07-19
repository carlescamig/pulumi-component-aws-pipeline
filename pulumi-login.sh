#!/bin/bash
set -euo pipefail

# Parámetros configurables
BUCKET_NAME="keken-pulumi-state-storage"
REGION="us-east-1"
PROFILE="keken-devops-us"

# Login a Pulumi con backend S3 y perfil
pulumi login "s3://$BUCKET_NAME?awssdk=v2&region=$REGION&profile=$PROFILE"

# Confirmación
echo "✅ Pulumi login successful using profile '$PROFILE' and bucket '$BUCKET_NAME'"
