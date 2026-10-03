# wp_seopress_get_settings

![seopress](https://img.shields.io/badge/category-seopress-lightgrey)

Gets a section of SEOPress global settings as JSON: titles (title/description templates and per-post-type noindex),
social (knowledge graph and default social images), sitemaps, advanced, bot, or woocommerce. Settings holding
credentials (indexing, license, analytics, Pro) are not available.

## Parameters

| Parameter | Type     | Required | Description       | Default | Examples  |
| --------- | -------- | -------- | ----------------- | ------- | --------- |
| `section` | `string` | ✅       | Settings section. | -       | `example` |

## Examples

### Basic seopress Usage

Simple example of using wp_seopress_get_settings

**Command:**

```bash
wp_seopress_get_settings --section="example_value"
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 123,
    "title": "Example seopress",
    "content": "Example content",
    "status": "publish",
    "date": "2024-01-01T00:00:00Z"
  }
}
```

**Error Example (Authentication failure):**

```json
{
  "error": "Authentication failed",
  "message": "Invalid credentials or insufficient permissions"
}
```

### Multi-Site seopress Usage

Using wp_seopress_get_settings with specific site targeting

**Command:**

```bash
wp_seopress_get_settings --site="site1" --section="example_value"
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 123,
    "title": "Example seopress",
    "content": "Example content",
    "status": "publish",
    "date": "2024-01-01T00:00:00Z"
  }
}
```

## Response Format

**Return Type:** `seopress`

```json
{
  "success": true,
  "data": {
    // seopress response data
  },
  "metadata": {
    "timestamp": "2024-01-01T00:00:00.000Z",
    "tool": "wp_seopress_get_settings",
    "site": "site1"
  }
}
```

## Error Handling

### AUTHENTICATION_FAILED

**Message:** Authentication failed **Description:** Invalid credentials or insufficient permissions **Resolution:**
Check your authentication credentials and user permissions

### VALIDATION_ERROR

**Message:** Parameter validation failed **Description:** One or more required parameters are missing or invalid
**Resolution:** Review the required parameters and their formats

### NOT_FOUND

**Message:** Resource not found **Description:** The requested resource does not exist **Resolution:** Verify the
resource ID and ensure it exists

### PERMISSION_DENIED

**Message:** Insufficient permissions **Description:** The user does not have permission to perform this action
**Resolution:** Contact an administrator to grant the necessary permissions

---

_Generated automatically from tool definitions - Do not edit manually_
