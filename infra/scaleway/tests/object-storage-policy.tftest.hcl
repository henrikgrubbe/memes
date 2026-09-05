mock_provider "scaleway" {
  mock_resource "scaleway_iam_application" {
    defaults = {
      id = "11111111-1111-1111-1111-111111111111"
    }
  }
}

variables {
  project_id = "00000000-0000-0000-0000-000000000000"
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
}
