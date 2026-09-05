mock_provider "scaleway" {
  mock_resource "scaleway_iam_application" {
    defaults = {
      id = "11111111-1111-1111-1111-111111111111"
    }
  }
}

mock_provider "time" {
  mock_resource "time_rotating" {
    defaults = {
      rfc3339          = "2026-01-01T00:00:00Z"
      rotation_rfc3339 = "2026-10-28T00:00:00Z"
    }
  }
}

variables {
  object_storage_provisioning_principal = "user_id:22222222-2222-2222-2222-222222222222"
  project_id                            = "00000000-0000-0000-0000-000000000000"
}

run "rejects_invalid_provisioning_principal" {
  command = plan

  variables {
    object_storage_provisioning_principal = "user_id:not-a-uuid"
  }

  expect_failures = [var.object_storage_provisioning_principal]
}

run "worker_retains_bucket_access" {
  command = plan

  assert {
    condition = contains(
      jsondecode(scaleway_object_bucket_policy.images.policy).Statement,
      {
        Sid       = "AllowAnonymousMemeReads"
        Effect    = "Allow"
        Principal = "*"
        Action    = ["s3:GetObject"]
        Resource  = ["${scaleway_object_bucket.images.name}/memes/*"]
      },
    )
    error_message = "Anonymous access must remain read-only and limited to the public memes prefix."
  }

  assert {
    condition = contains(
      jsondecode(scaleway_object_bucket_policy.images.policy).Statement,
      {
        Sid    = "AllowWorkerObjectAccess"
        Effect = "Allow"
        Principal = {
          SCW = "application_id:11111111-1111-1111-1111-111111111111"
        }
        Action = ["s3:GetObject", "s3:PutObject"]
        Resource = [
          "${scaleway_object_bucket.images.name}/memes/*",
          "${scaleway_object_bucket.images.name}/terminal-outcomes/*",
        ]
      },
    )
    error_message = "The bucket policy must explicitly retain worker read/write access to image and terminal-outcome objects."
  }

  assert {
    condition = contains(
      jsondecode(scaleway_object_bucket_policy.images.policy).Statement,
      {
        Sid    = "AllowProvisioningObjectStorageManagement"
        Effect = "Allow"
        Principal = {
          SCW = "user_id:22222222-2222-2222-2222-222222222222"
        }
        Action = [
          "s3:GetBucketAcl",
          "s3:GetBucketCORS",
          "s3:GetBucketLocation",
          "s3:GetBucketObjectLockConfiguration",
          "s3:GetBucketTagging",
          "s3:GetBucketVersioning",
          "s3:GetLifecycleConfiguration",
          "s3:ListBucket",
          "s3:PutBucketAcl",
        ]
        Resource = [scaleway_object_bucket.images.name]
      },
    )
    error_message = "The bucket policy must retain the provisioning principal's least-privilege bucket management access."
  }

  assert {
    condition     = time_rotating.worker_storage.rotation_days == 300
    error_message = "The worker API key must rotate before its expiration window."
  }

  assert {
    condition     = scaleway_iam_api_key.worker_storage.expires_at == "2026-11-27T00:00:00Z"
    error_message = "The worker API key must expire 330 days after its rotation anchor."
  }
}
