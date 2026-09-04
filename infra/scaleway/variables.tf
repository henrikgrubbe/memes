variable "project_id" {
  description = "Scaleway project ID that owns every deployment resource."
  type        = string
}

variable "region" {
  description = "Scaleway region for registry, queues, and containers."
  type        = string
  default     = "fr-par"

  validation {
    condition     = var.region == "fr-par"
    error_message = "This deployment is intentionally constrained to fr-par."
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

variable "deploy_containers" {
  description = "Create containers only after both images have been pushed."
  type        = bool
  default     = false
}

variable "worker_trigger_enabled" {
  description = "Attach the queue trigger. Keep false until diagnostic canary."
  type        = bool
  default     = false

  validation {
    condition     = !var.worker_trigger_enabled || var.deploy_containers
    error_message = "worker_trigger_enabled requires deploy_containers=true."
  }

  validation {
    condition = !(
      var.worker_trigger_enabled &&
      var.hosted_ingress_mode == "live" &&
      var.worker_mode == "diagnostic"
    )
    error_message = "A live ingress cannot attach a diagnostic worker because successful diagnostics acknowledge and delete requests."
  }
}

variable "image_tag" {
  description = "Immutable tag pushed for both webhook and worker images."
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
  description = "Branch that receives hosted worker output commits."
  type        = string
  default     = "main"
}

variable "hosted_ingress_mode" {
  description = "Ingress routing: off, exclusive labelled canary, or live."
  type        = string
  default     = "off"

  validation {
    condition     = contains(["off", "canary", "live"], var.hosted_ingress_mode)
    error_message = "hosted_ingress_mode must be off, canary, or live."
  }
}

variable "hosted_canary_label" {
  description = "Reserved issue label routed exclusively to hosted processing in canary mode."
  type        = string
  default     = "hosted-canary"

  validation {
    condition     = var.hosted_canary_label == "hosted-canary"
    error_message = "hosted_canary_label must match the workflow's reserved hosted-canary label."
  }
}

variable "worker_mode" {
  description = "Worker behavior: diagnostic has no side effects; live processes tasks."
  type        = string
  default     = "diagnostic"

  validation {
    condition     = contains(["diagnostic", "live"], var.worker_mode)
    error_message = "worker_mode must be diagnostic or live."
  }
}

variable "worker_diagnostic_response" {
  description = "Diagnostic response: success acknowledges; retry returns HTTP 503."
  type        = string
  default     = "success"

  validation {
    condition     = contains(["success", "retry"], var.worker_diagnostic_response)
    error_message = "worker_diagnostic_response must be success or retry."
  }
}

variable "worker_privacy" {
  description = "Start private; use public temporarily only if live canary disproves trigger compatibility."
  type        = string
  default     = "private"

  validation {
    condition     = contains(["private", "public"], var.worker_privacy)
    error_message = "worker_privacy must be private or public."
  }
}

variable "queue_visibility_timeout_seconds" {
  description = "Time a received request stays hidden; must exceed worker timeout."
  type        = number
  default     = 900

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
  default     = 840

  validation {
    condition     = var.worker_timeout_seconds >= 60 && var.worker_timeout_seconds < 900
    error_message = "Worker timeout must be at least 60 and below 900 seconds."
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
