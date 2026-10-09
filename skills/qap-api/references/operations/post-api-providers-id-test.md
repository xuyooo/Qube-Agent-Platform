# POST /api/providers/{id}/test

**Resource:** [providers](../resources/providers.md)
**Probe the provider with a minimal request**
**Operation ID:** `post--api-providers-{id}-test`

## Parameters

| Name | In | Type | Required | Description |
|------|------|------|----------|-------------|
| `id` | path | string | Yes |  |

## Request Body

**Content Types:** `application/json`

**Schema** (inline):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `model` | string | No |  |
| `provider_type` | string | No |  |
| `base_url` | string | No |  |
| `api_key` | string | No |  |
| `model_profile` | any | No |  |

## Responses

| Status | Description |
|--------|-------------|
| 200 | Probe result |
| 404 | Provider not found |

**Success Response Schema** (inline):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ok` | boolean | Yes |  |
| `detail` | string | No |  |
| `profile_ok` | boolean | No |  |
| `profile_detail` | string | No |  |

## Security

- **bearerAuth**
