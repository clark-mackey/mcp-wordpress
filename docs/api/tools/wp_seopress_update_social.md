# wp_seopress_update_social

![seopress](https://img.shields.io/badge/category-seopress-lightgrey)

Sets SEOPress Open Graph (Facebook, LinkedIn) and X (Twitter) title, description, and image of a post, page, or custom
post type item. Empty strings clear a field so SEOPress falls back to the SEO title, description, or default image.
Images are given as media library IDs; 0 clears the image. Reads the stored values back and fails if SEOPress did not
store what was sent, listing the previous values so the change can be undone.

## Parameters

| Parameter              | Type     | Required | Description                                                  | Default | Examples     |
| ---------------------- | -------- | -------- | ------------------------------------------------------------ | ------- | ------------ |
| `id`                   | `number` | ✅       | The ID of the post, page, or custom post type item.          | -       | `123`, `456` |
| `facebook_title`       | `string` | ❌       | Open Graph title.                                            | -       | `example`    |
| `facebook_description` | `string` | ❌       | Open Graph description.                                      | -       | `example`    |
| `facebook_image_id`    | `number` | ❌       | Media library ID of the Open Graph image. 0 clears it.       | -       | `example`    |
| `x_title`              | `string` | ❌       | X (Twitter) card title.                                      | -       | `example`    |
| `x_description`        | `string` | ❌       | X (Twitter) card description.                                | -       | `example`    |
| `x_image_id`           | `number` | ❌       | Media library ID of the X (Twitter) card image. 0 clears it. | -       | `example`    |

## Examples

### Basic seopress Usage

Simple example of using wp_seopress_update_social

**Command:**

```bash
wp_seopress_update_social --id="123"
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

Using wp_seopress_update_social with specific site targeting

**Command:**

```bash
wp_seopress_update_social --site="site1" --id="123"
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
wp_seopress_update_social --id="123" --facebook_title="example_value" --facebook_description="example_value" --facebook_image_id="example_value" --x_title="example_value" --x_description="example_value" --x_image_id="example_value"
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
    "tool": "wp_seopress_update_social",
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
