locals {
  common_tags = ["app=memes", "managed-by=opentofu", "region=${var.region}"]

  ingress_image = "${scaleway_registry_namespace.main.endpoint}/webhook:${var.image_tag}"
  worker_image  = "${scaleway_registry_namespace.main.endpoint}/worker:${var.image_tag}"
}

resource "scaleway_registry_namespace" "main" {
  name        = "${var.name_prefix}-containers"
  description = "Public images for hosted meme processing"
  is_public   = true
  project_id  = var.project_id
  region      = var.region
}

resource "scaleway_mnq_sqs" "main" {
  project_id = var.project_id
  region     = var.region
}

resource "scaleway_mnq_sqs_credentials" "manager" {
  name       = "${var.name_prefix}-queue-manager"
  project_id = var.project_id
  region     = var.region

  permissions {
    can_manage  = true
    can_publish = false
    can_receive = false
  }

  depends_on = [scaleway_mnq_sqs.main]
}

resource "scaleway_mnq_sqs_credentials" "ingress" {
  name       = "${var.name_prefix}-ingress-publisher"
  project_id = var.project_id
  region     = var.region

  permissions {
    can_manage  = false
    can_publish = true
    can_receive = false
  }

  depends_on = [scaleway_mnq_sqs.main]
}

resource "scaleway_mnq_sqs_credentials" "trigger" {
  name       = "${var.name_prefix}-worker-receiver"
  project_id = var.project_id
  region     = var.region

  permissions {
    can_manage  = false
    can_publish = false
    can_receive = true
  }

  depends_on = [scaleway_mnq_sqs.main]
}

resource "scaleway_mnq_sqs_credentials" "operations" {
  name       = "${var.name_prefix}-queue-operations"
  project_id = var.project_id
  region     = var.region

  permissions {
    can_manage  = false
    can_publish = true
    can_receive = true
  }

  depends_on = [scaleway_mnq_sqs.main]
}

resource "scaleway_mnq_sqs_queue" "dead_letter" {
  name                        = "${var.name_prefix}-requests-dlq.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  message_max_age             = var.queue_retention_seconds
  visibility_timeout_seconds  = var.queue_visibility_timeout_seconds
  project_id                  = var.project_id
  region                      = var.region
  sqs_endpoint                = scaleway_mnq_sqs.main.endpoint
  access_key                  = scaleway_mnq_sqs_credentials.manager.access_key
  secret_key                  = scaleway_mnq_sqs_credentials.manager.secret_key
}

resource "scaleway_mnq_sqs_queue" "requests" {
  name                        = "${var.name_prefix}-requests.fifo"
  fifo_queue                  = true
  content_based_deduplication = false
  message_max_age             = var.queue_retention_seconds
  receive_wait_time_seconds   = 20
  visibility_timeout_seconds  = var.queue_visibility_timeout_seconds
  project_id                  = var.project_id
  region                      = var.region
  sqs_endpoint                = scaleway_mnq_sqs.main.endpoint
  access_key                  = scaleway_mnq_sqs_credentials.manager.access_key
  secret_key                  = scaleway_mnq_sqs_credentials.manager.secret_key

  dead_letter_queue {
    id                = scaleway_mnq_sqs_queue.dead_letter.id
    max_receive_count = 4
  }
}

resource "scaleway_container_namespace" "main" {
  name        = "${var.name_prefix}-runtime"
  description = "Hosted meme webhook and queue worker"
  tags        = local.common_tags
  project_id  = var.project_id
  region      = var.region
}

resource "scaleway_container" "ingress" {
  count = var.deploy_containers ? 1 : 0

  name               = "${var.name_prefix}-webhook"
  description        = "Signed GitHub webhook ingress"
  namespace_id       = scaleway_container_namespace.main.id
  image              = local.ingress_image
  registry_sha256    = var.image_tag
  port               = 8080
  protocol           = "http1"
  privacy            = "public"
  min_scale          = 0
  max_scale          = 2
  cpu_limit          = 140
  memory_limit_bytes = 256000000
  timeout            = 30
  tags               = local.common_tags

  environment_variables = {
    HOSTED_CANARY_LABEL = var.hosted_canary_label
    HOSTED_INGRESS_MODE = var.hosted_ingress_mode
    SQS_ENDPOINT        = scaleway_mnq_sqs.main.endpoint
    SQS_QUEUE_URL       = scaleway_mnq_sqs_queue.requests.url
    SQS_REGION          = var.region
  }

  secret_environment_variables = {
    GITHUB_WEBHOOK_SECRET = var.github_webhook_secret
    SQS_ACCESS_KEY        = scaleway_mnq_sqs_credentials.ingress.access_key
    SQS_SECRET_KEY        = scaleway_mnq_sqs_credentials.ingress.secret_key
  }

  liveness_probe {
    http {
      path = "/health"
    }
    failure_threshold = 3
    interval          = "30s"
    timeout           = "5s"
  }

  lifecycle {
    precondition {
      condition     = var.github_webhook_secret != null
      error_message = "github_webhook_secret is required when deploy_containers=true."
    }
  }
}

resource "scaleway_container" "worker" {
  count = var.deploy_containers ? 1 : 0

  name               = "${var.name_prefix}-worker"
  description        = "FIFO queue-triggered meme worker"
  namespace_id       = scaleway_container_namespace.main.id
  image              = local.worker_image
  registry_sha256    = var.image_tag
  port               = 8080
  protocol           = "http1"
  privacy            = var.worker_privacy
  min_scale          = 0
  max_scale          = 1
  cpu_limit          = 1120
  memory_limit_bytes = 2048000000
  timeout            = var.worker_timeout_seconds
  tags               = local.common_tags

  environment_variables = {
    GITHUB_API_URL             = "https://api.github.com"
    GITHUB_REPOSITORY          = var.github_repository
    GITHUB_TARGET_BRANCH       = var.github_target_branch
    WORKER_DIAGNOSTIC_RESPONSE = var.worker_diagnostic_response
    WORKER_MODE                = var.worker_mode
  }

  secret_environment_variables = merge(
    {
      GITHUB_FINE_GRAINED_PAT = var.github_fine_grained_pat
      OPENAI_API_KEY          = var.openai_api_key
      SLACK_WEBHOOK_URL       = var.slack_webhook_url
    },
    var.xai_api_key == null ? {} : { XAI_API_KEY = var.xai_api_key },
  )

  scaling_option {
    concurrent_requests_threshold = 1
  }

  liveness_probe {
    http {
      path = "/health"
    }
    failure_threshold = 3
    interval          = "30s"
    timeout           = "5s"
  }

  lifecycle {
    precondition {
      condition = alltrue([
        var.github_fine_grained_pat != null,
        var.openai_api_key != null,
        var.slack_webhook_url != null,
      ])
      error_message = "GitHub, OpenAI, and Slack worker secrets are required when deploy_containers=true."
    }
  }
}

resource "scaleway_container_trigger" "worker" {
  count = var.deploy_containers && var.worker_trigger_enabled ? 1 : 0

  name         = "${var.name_prefix}-queue-worker"
  description  = "Deliver FIFO requests to the worker"
  container_id = scaleway_container.worker[0].id
  region       = var.region

  destination_config {
    http_path   = "/queue"
    http_method = "post"
  }

  sqs {
    endpoint   = scaleway_mnq_sqs.main.endpoint
    queue_url  = scaleway_mnq_sqs_queue.requests.url
    access_key = scaleway_mnq_sqs_credentials.trigger.access_key
    secret_key = scaleway_mnq_sqs_credentials.trigger.secret_key
    project_id = var.project_id
    region     = var.region
  }
}
