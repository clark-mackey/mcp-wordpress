# wp_redirection_create_redirect

![redirection](https://img.shields.io/badge/category-redirection-lightgrey)

Creates a Redirection redirect from a path on this site to a target URL. Fails without saving when another redirect
already handles the source (Redirection ignores case and a trailing slash by default) or when the redirect would loop,
and warns when the target is itself redirected. Reads the redirect back and fails if Redirection did not store what was
sent, reporting the stored values. Check the live response afterwards with wp_redirection_check_redirect.

## Parameters

| Parameter  | Type      | Required | Description                                                                                                                    | Default | Examples                      |
| ---------- | --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ | ------- | ----------------------------- |
| `source`   | `string`  | ✅       | The old path on this site, starting with "/", such as /old-page/. A regular expression when regex is true.                     | -       | `example`                     |
| `target`   | `string`  | ✅       | Where to send visitors: a path starting with "/" or a full URL.                                                                | -       | `example`                     |
| `code`     | `number`  | ❌       | HTTP status, one of 301, 302, 307, 308: 301 (permanent, the default for moved pages), 302 or 307 (temporary), 308 (permanent). | -       | `example`                     |
| `group_id` | `number`  | ❌       | Redirection group ID. Default: the first enabled group in the WordPress module.                                                | -       | `example`                     |
| `title`    | `string`  | ❌       | Optional note shown in the Redirection list.                                                                                   | -       | `My Blog Post`, `Hello World` |
| `regex`    | `boolean` | ❌       | Treat source as a regular expression (default false).                                                                          | -       | `example`                     |

## Examples

### Basic redirection Usage

Simple example of using wp_redirection_create_redirect

**Command:**

```bash
wp_redirection_create_redirect --source="example_value" --target="example_value"
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

### Multi-Site redirection Usage

Using wp_redirection_create_redirect with specific site targeting

**Command:**

```bash
wp_redirection_create_redirect --site="site1" --source="example_value"
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

### Advanced redirection Configuration

Comprehensive example using all available parameters

**Command:**

```bash
wp_redirection_create_redirect --source="example_value" --target="example_value" --code="example_value" --group_id="example_value" --title="Example Post Title" --regex="example_value"
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

**Return Type:** `redirection`

```json
{
  "success": true,
  "data": {
    // redirection response data
  },
  "metadata": {
    "timestamp": "2024-01-01T00:00:00.000Z",
    "tool": "wp_redirection_create_redirect",
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
