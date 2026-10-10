# wp_redirection_update_redirect

![redirection](https://img.shields.io/badge/category-redirection-lightgrey)

Changes the source, target, status code, title, or group of a plain URL redirect. Omitted fields are unchanged. Refuses
redirects using other match conditions or actions, which belong in wp-admin, and applies the same duplicate and loop
checks as creating. Reads the redirect back and fails if Redirection did not store what was sent, reporting the stored
values. Reports the previous values.

## Parameters

| Parameter  | Type     | Required | Description                                                                                                                    | Default | Examples                      |
| ---------- | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ | ------- | ----------------------------- |
| `id`       | `number` | ✅       | The Redirection redirect ID.                                                                                                   | -       | `123`, `456`                  |
| `source`   | `string` | ❌       | New source path, starting with "/".                                                                                            | -       | `example`                     |
| `target`   | `string` | ❌       | New target: a path starting with "/" or a full URL.                                                                            | -       | `example`                     |
| `code`     | `number` | ❌       | HTTP status, one of 301, 302, 307, 308: 301 (permanent, the default for moved pages), 302 or 307 (temporary), 308 (permanent). | -       | `example`                     |
| `title`    | `string` | ❌       | New title; an empty string clears it.                                                                                          | -       | `My Blog Post`, `Hello World` |
| `group_id` | `number` | ❌       | Move the redirect to this Redirection group.                                                                                   | -       | `example`                     |

## Examples

### Basic redirection Usage

Simple example of using wp_redirection_update_redirect

**Command:**

```bash
wp_redirection_update_redirect --id="123"
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

Using wp_redirection_update_redirect with specific site targeting

**Command:**

```bash
wp_redirection_update_redirect --site="site1" --id="123"
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
wp_redirection_update_redirect --id="123" --source="example_value" --target="example_value" --code="example_value" --title="Example Post Title" --group_id="example_value"
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
    "tool": "wp_redirection_update_redirect",
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
