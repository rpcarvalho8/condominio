#!/usr/bin/env bash
# Local MinIO (dev only) smoke: compose up → healthy → bucket ready (idempotent) → put/exists/get.
# Does NOT mark staging/prod ready. Does not migrate data/content.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMPOSE_FILE="${ROOT}/docker-compose.minio.yml"
export MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
export MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"
export MINIO_BUCKET="${MINIO_BUCKET:-lumen-dev}"

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "${COMPOSE_FILE}" "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose -f "${COMPOSE_FILE}" "$@"
  else
    echo "docker compose is required for this smoke (local MinIO only)." >&2
    exit 1
  fi
}

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for this smoke (local MinIO only)." >&2
  exit 1
fi

echo "==> compose up minio (wait healthy)"
compose up -d --wait minio

echo "==> create-bucket (1st, idempotent)"
compose run --rm --no-deps createbucket

echo "==> create-bucket (2nd, must stay idempotent)"
compose run --rm --no-deps createbucket

export OBJECT_STORAGE_LIVE_S3=1
export OBJECT_STORAGE_DRIVER=s3
export S3_ENDPOINT="${S3_ENDPOINT:-http://127.0.0.1:9000}"
export S3_BUCKET="${S3_BUCKET:-${MINIO_BUCKET}}"
export S3_REGION="${S3_REGION:-us-east-1}"
export S3_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-${MINIO_ROOT_USER}}"
export S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-${MINIO_ROOT_PASSWORD}}"
export S3_KEY_PREFIX="${S3_KEY_PREFIX:-lumen-dev}"
export S3_FORCE_PATH_STYLE="${S3_FORCE_PATH_STYLE:-1}"
unset S3_VIRTUAL_HOSTED_STYLE || true

echo "==> live bun test (put/exists/get)"
(
  cd "${ROOT}/packages/web"
  bun test src/api/infra/object-storage.test.ts -t "S3 live put/get/exists"
)

echo "==> explicit put → exists → get (bytes equal)"
(
  cd "${ROOT}/packages/web"
  bun --eval '
    import { createObjectStorageFromEnv } from "./src/api/infra/object-storage.ts";
    const storage = createObjectStorageFromEnv();
    if (storage.driver !== "s3") {
      throw new Error("expected driver=s3, got " + storage.driver);
    }
    const bytes = Buffer.from("minio-smoke-" + Date.now());
    const put = await storage.put({ tenantId: "f1-minio-smoke", bytes });
    const exists = await storage.exists({ tenantId: "f1-minio-smoke", key: put.key });
    const got = await storage.get({ tenantId: "f1-minio-smoke", key: put.key });
    const equal = got.equals(bytes);
    console.log("driver=" + storage.driver);
    console.log("endpoint=" + process.env.S3_ENDPOINT);
    console.log("bucket=" + process.env.S3_BUCKET);
    console.log("key=" + put.key);
    console.log("byteSize=" + put.byteSize);
    console.log("exists=" + exists);
    console.log("bytes_equal=" + equal);
    if (!exists || !equal) process.exit(1);
  '
)

echo
echo "MinIO local smoke OK (put→exists→get, bucket idempotent)."
echo "NOT production-ready — technical local integration only."
