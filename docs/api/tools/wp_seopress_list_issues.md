# wp_seopress_list_issues

![seopress](https://img.shields.io/badge/category-seopress-lightgrey)

Lists posts, pages, and custom post type items with a SEOPress issue: no SEO title, no meta description, either missing,
or an explicit noindex. Scans every public content type unless post_types is given.

## Parameters

| Parameter    | Type     | Required | Description                                                                      | Default   | Examples  |
| ------------ | -------- | -------- | -------------------------------------------------------------------------------- | --------- | --------- |
| `issue`      | `string` | ✅       | The issue to look for.                                                           | -         | `example` |
| `post_types` | `array`  | ❌       | REST bases to scan, e.g. ["posts", "pages"]. Default: every public content type. | -         | `example` |
| `status`     | `string` | ❌       | Post status to scan. Default: publish.                                           | `publish` | `example` |
| `max_items`  | `number` | ❌       | Maximum items to list (1-1000). Default: 200.                                    | -         | `example` |

## Examples

### Basic seopress Usage

Simple example of using wp_seopress_list_issues

**Command:**

```bash
wp_seopress_list_issues --issue="example_value"
```

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "Example seopress 1",
      "status": "publish"
    },
    {
      "id": 2,
      "title": "Example seopress 2",
      "status": "draft"
    }
  ],
  "total": 2,
  "pages": 1
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

Using wp_seopress_list_issues with specific site targeting

**Command:**

```bash
wp_seopress_list_issues --site="site1" --issue="example_value"
```

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "Example seopress 1",
      "status": "publish"
    },
    {
      "id": 2,
      "title": "Example seopress 2",
      "status": "draft"
    }
  ],
  "total": 2,
  "pages": 1
}
```

### Advanced seopress Configuration

Comprehensive example using all available parameters

**Command:**

```bash
wp_seopress_list_issues --issue="example_value" --post_types="example_value" --status="publish" --max_items="example_value"
```

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "Example seopress 1",
      "status": "publish"
    },
    {
      "id": 2,
      "title": "Example seopress 2",
      "status": "draft"
    }
  ],
  "total": 2,
  "pages": 1
}
```

## Response Format

**Return Type:** `seopress[]`

```json
{
  "success": true,
  "data": {
    // seopress[] response data
  },
  "metadata": {
    "timestamp": "2024-01-01T00:00:00.000Z",
    "tool": "wp_seopress_list_issues",
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
