terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    scaleway = {
      source  = "scaleway/scaleway"
      version = "~> 2.82.0"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.14.0"
    }
  }
}

provider "scaleway" {
  project_id = var.project_id
  region     = var.region
}
