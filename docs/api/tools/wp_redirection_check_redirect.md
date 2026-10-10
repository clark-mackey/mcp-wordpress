# wp_redirection_check_redirect

![redirection](https://img.shields.io/badge/category-redirection-lightgrey)

Requests a path on this site as an anonymous visitor, without following redirects, and reports the HTTP status, the
redirect target, what sent it, and whether a page cache answered. With expected_code or expected_target it fails when
the live response differs.

## Parameters

| Parameter         | Type     | Required | Description                                                                    | Default | Examples  |
| ----------------- | -------- | -------- | ------------------------------------------------------------------------------ | ------- | --------- |
| `path`            | `string` | ✅       | The path to request, starting with "/", such as /old-page/.                    | -       | `example` |
| `expected_code`   | `number` | ❌       | The HTTP status the response must have, such as 301.                           | -       | `example` |
| `expected_target` | `string` | ❌       | The URL the response must redirect to: a path starting with "/" or a full URL. | -       | `example` |

## Examples

### Basic redirection Usage

Simple example of using wp_redirection_check_redirect

**Command:**

```bash
wp_redirection_check_redirect --path="example_value"
```

**Response:**

```json
{
  "success": true,
  "data": {},
  "message": "wp_redirection_check_redirect executed successfully"
}
```

**Error Example (Authentication failure):**

```json
{
  "error": "Authentication failed",
  "message": "Invalid credentials or insufficient permissions"
}
```

### Multi-Site redirection Usage

Using wp_redirection_check_redirect with specific site targeting

**Command:**

```bash
wp_redirection_check_redirect --site="site1" --path="example_value"
```

**Response:**

```json
{
  "success": true,
  "data": {},
  "message": "wp_redirection_check_redirect executed successfully"
}
```

### Advanced redirection Configuration

Comprehensive example using all available parameters

**Command:**

```bash
wp_redirection_check_redirect --path="example_value" --expected_code="example_value" --expected_target="example_value"
```

**Response:**

```json
{
  "success": true,
  "data": {},
  "message": "wp_redirection_check_redirect executed successfully"
}
```

## Response Format

**Return Type:** `object`

```json
{
  "success": true,
  "data": {
    // object response data
  },
  "metadata": {
    "timestamp": "2024-01-01T00:00:00.000Z",
    "tool": "wp_redirection_check_redirect",
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
