# wp_seopress_update_target_keywords

![seopress](https://img.shields.io/badge/category-seopress-lightgrey)

Replaces the SEOPress target keywords (used by its content analysis) of a post, page, or custom post type item. An empty
list clears them. Reads the stored values back and fails if SEOPress did not store what was sent, listing the previous
values so the change can be undone.

## Parameters

| Parameter  | Type     | Required | Description                                         | Default | Examples     |
| ---------- | -------- | -------- | --------------------------------------------------- | ------- | ------------ |
| `id`       | `number` | ✅       | The ID of the post, page, or custom post type item. | -       | `123`, `456` |
| `keywords` | `array`  | ✅       | Target keywords in priority order, without commas.  | -       | `example`    |

## Examples

### Basic seopress Usage

Simple example of using wp_seopress_update_target_keywords

**Command:**

```bash
wp_seopress_update_target_keywords --id="123" --keywords="example_value"
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

Using wp_seopress_update_target_keywords with specific site targeting

**Command:**

```bash
wp_seopress_update_target_keywords --site="site1" --id="123"
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
    "tool": "wp_seopress_update_target_keywords",
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
