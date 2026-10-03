# wp_seopress_update_title_description

![seopress](https://img.shields.io/badge/category-seopress-lightgrey)

Sets the SEOPress SEO title and/or meta description of a post, page, or custom post type item. An empty string clears
the field so SEOPress uses the site's default template. Template variables such as %%sitetitle%% are stored as written.
Reads the stored values back and fails if SEOPress did not store what was sent, listing the previous values so the
change can be undone. Also reports the title and description SEOPress outputs when published.

## Parameters

| Parameter     | Type     | Required | Description                                         | Default | Examples                      |
| ------------- | -------- | -------- | --------------------------------------------------- | ------- | ----------------------------- |
| `id`          | `number` | ✅       | The ID of the post, page, or custom post type item. | -       | `123`, `456`                  |
| `title`       | `string` | ❌       | The SEO title. Omit to leave it unchanged.          | -       | `My Blog Post`, `Hello World` |
| `description` | `string` | ❌       | The meta description. Omit to leave it unchanged.   | -       | `example`                     |

## Examples

### Basic seopress Usage

Simple example of using wp_seopress_update_title_description

**Command:**

```bash
wp_seopress_update_title_description --id="123"
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

Using wp_seopress_update_title_description with specific site targeting

**Command:**

```bash
wp_seopress_update_title_description --site="site1" --id="123"
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
wp_seopress_update_title_description --id="123" --title="Example Post Title" --description="example_value"
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
    "tool": "wp_seopress_update_title_description",
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
