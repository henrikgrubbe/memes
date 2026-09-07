variable "project_id" {
  description = "Scaleway project ID that owns every deployment resource."
  type        = string
}

variable "region" {
  description = "Scaleway region for registry, queues, and containers."
  type        = string
  default     = "nl-ams"

  validation {
    condition     = contains(["fr-par", "nl-ams"], var.region)
    error_message = "region must be fr-par or nl-ams."
  }
}

variable "name_prefix" {
  description = "Stable prefix for resource names."
  type        = string
  default     = "memes"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.name_prefix))
    error_message = "name_prefix must be 2-31 lowercase letters, digits, or hyphens."
  }
}

variable "object_storage_bucket_name" {
  description = "Globally unique Object Storage bucket name; defaults to a project-specific name."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = var.object_storage_bucket_name == null || can(regex(
      "^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$",
      var.object_storage_bucket_name,
    ))
    error_message = "object_storage_bucket_name must be a valid 3-63 character lowercase bucket name."
  }
}

variable "object_storage_provisioning_principal" {
  description = "Scaleway IAM principal that runs OpenTofu, formatted as user_id:<uuid> or application_id:<uuid>."
  type        = string

  validation {
    condition = can(regex(
      "^(user_id|application_id):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
      var.object_storage_provisioning_principal,
    ))
    error_message = "object_storage_provisioning_principal must be user_id:<uuid> or application_id:<uuid>."
  }
}

variable "image_tag" {
  description = "Immutable bootstrap tag used when the containers are first created."
  type        = string
  default     = "not-pushed"

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$", var.image_tag))
    error_message = "image_tag must be a valid OCI tag."
  }
}

variable "github_repository" {
  description = "GitHub repository accepted by the worker."
  type        = string
  default     = "henrikgrubbe/memes"
}

variable "github_target_branch" {
  description = "Branch that receives hosted worker Saga commits."
  type        = string
  default     = "main"
}

variable "queue_visibility_timeout_seconds" {
  description = "Time a received request stays hidden; must exceed worker timeout."
  type        = number
  default     = 240

  validation {
    condition     = var.queue_visibility_timeout_seconds > var.worker_timeout_seconds && var.queue_visibility_timeout_seconds <= 43200
    error_message = "Queue visibility must exceed worker timeout and be at most 43200 seconds."
  }
}

variable "queue_retention_seconds" {
  description = "Request and DLQ retention in seconds."
  type        = number
  default     = 86400

  validation {
    condition     = var.queue_retention_seconds >= 86400 && var.queue_retention_seconds <= 1209600
    error_message = "Queue retention must be between one and fourteen days."
  }
}

variable "worker_timeout_seconds" {
  description = "Maximum worker request duration."
  type        = number
  default     = 180

  validation {
    condition     = var.worker_timeout_seconds >= 60 && var.worker_timeout_seconds < 3600
    error_message = "Worker timeout must be at least 60 and below 3600 seconds."
  }
}

variable "github_webhook_secret" {
  description = "Shared GitHub webhook HMAC secret."
  type        = string
  sensitive   = true
  default     = null
  nullable    = true
}

variable "github_fine_grained_pat" {
  description = "Short-lived repository-scoped GitHub token."
  type        = string
  sensitive   = true
  default     = null
  nullable    = true
}

variable "slack_webhook_url" {
  description = "Slack incoming webhook used for completion notifications."
  type        = string
  sensitive   = true
  default     = null
  nullable    = true
}

variable "openai_api_key" {
  description = "OpenAI API key used for image generation and saga compression."
  type        = string
  sensitive   = true
  default     = null
  nullable    = true
}

variable "xai_api_key" {
  description = "Optional xAI fallback key."
  type        = string
  sensitive   = true
  default     = null
  nullable    = true
}
