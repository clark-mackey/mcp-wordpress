# wp_seopress_update_robots

![seopress](https://img.shields.io/badge/category-seopress-lightgrey)

Sets SEOPress robots settings of a post, page, or custom post type item. Omitted fields are unchanged. Fails without
saving if a requested field is set by SEOPress global settings for this item. Reads the stored values back and fails if
SEOPress did not store what was sent, listing the previous values so the change can be undone.

## Parameters

| Parameter              | Type      | Required | Description                                                                               | Default | Examples     |
| ---------------------- | --------- | -------- | ----------------------------------------------------------------------------------------- | ------- | ------------ |
| `id`                   | `number`  | ✅       | The ID of the post, page, or custom post type item.                                       | -       | `123`, `456` |
| `noindex`              | `boolean` | ❌       | true hides the item from search results (noindex).                                        | -       | `example`    |
| `nofollow`             | `boolean` | ❌       | true tells search engines not to follow its links (nofollow).                             | -       | `example`    |
| `noimageindex`         | `boolean` | ❌       | true stops search engines indexing its images.                                            | -       | `example`    |
| `nosnippet`            | `boolean` | ❌       | true stops search engines showing a snippet.                                              | -       | `example`    |
| `canonical`            | `string`  | ❌       | Canonical URL. An empty string removes the custom canonical (the item's own URL is used). | -       | `example`    |
| `primary_category`     | `number`  | ❌       | Term ID of the primary category (used in breadcrumbs and permalinks). 0 clears it.        | -       | `example`    |
| `freeze_modified_date` | `boolean` | ❌       | true keeps the item's modified date from changing on save.                                | -       | `example`    |

## Examples

### Basic seopress Usage

Simple example of using wp_seopress_update_robots

**Command:**

```bash
wp_seopress_update_robots --id="123"
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 123,
    "title": "Created/Updated successfully",
    "status": "publish"
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

Using wp_seopress_update_robots with specific site targeting

**Command:**

```bash
wp_seopress_update_robots --site="site1" --id="123"
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 123,
    "title": "Created/Updated successfully",
    "status": "publish"
  }
}
```

### Advanced seopress Configuration

Comprehensive example using all available parameters

**Command:**

```bash
wp_seopress_update_robots --id="123" --noindex="example_value" --nofollow="example_value" --noimageindex="example_value" --nosnippet="example_value" --canonical="example_value" --primary_category="example_value" --freeze_modified_date="example_value"
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": 123,
    "title": "Created/Updated successfully",
    "status": "publish"
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
    "tool": "wp_seopress_update_robots",
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
