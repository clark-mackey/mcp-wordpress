# wp_seopress_update_redirect

![seopress](https://img.shields.io/badge/category-seopress-lightgrey)

Sets the SEOPress redirect of a post, page, or custom post type item. When enabled on a published item, visitors to it
are redirected immediately. Omitted fields are unchanged. After saving an enabled redirect, tests the destination and
reports its HTTP status. Reads the stored values back and fails if SEOPress did not store what was sent, listing the
previous values so the change can be undone. For site-wide redirect lists use the Redirection plugin tools instead.

## Parameters

| Parameter       | Type      | Required | Description                                         | Default | Examples     |
| --------------- | --------- | -------- | --------------------------------------------------- | ------- | ------------ |
| `id`            | `number`  | ✅       | The ID of the post, page, or custom post type item. | -       | `123`, `456` |
| `enabled`       | `boolean` | ❌       | true turns the redirect on; false turns it off.     | -       | `example`    |
| `url`           | `string`  | ❌       | Destination URL, absolute or relative to the site.  | -       | `example`    |
| `type`          | `string`  | ❌       | Redirect status code.                               | -       | `example`    |
| `logged_status` | `string`  | ❌       | Which visitors are redirected.                      | -       | `example`    |

## Examples

### Basic seopress Usage

Simple example of using wp_seopress_update_redirect

**Command:**

```bash
wp_seopress_update_redirect --id="123"
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

Using wp_seopress_update_redirect with specific site targeting

**Command:**

```bash
wp_seopress_update_redirect --site="site1" --id="123"
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
wp_seopress_update_redirect --id="123" --enabled="example_value" --url="example_value" --type="example_value" --logged_status="example_value"
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
    "tool": "wp_seopress_update_redirect",
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
