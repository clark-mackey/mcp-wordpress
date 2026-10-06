# wp_redirection_list_redirects

![redirection](https://img.shields.io/badge/category-redirection-lightgrey)

Lists redirects managed by the Redirection plugin, newest first, with ID, source, status code, target, enabled state,
group, and hit count. Filters match part of the source or target.

## Parameters

| Parameter  | Type     | Required | Description                                     | Default   | Examples   |
| ---------- | -------- | -------- | ----------------------------------------------- | --------- | ---------- |
| `source`   | `string` | ❌       | Only redirects whose source contains this text. | -         | `example`  |
| `target`   | `string` | ❌       | Only redirects whose target contains this text. | -         | `example`  |
| `status`   | `string` | ❌       | Only enabled or disabled redirects.             | `publish` | `example`  |
| `group_id` | `number` | ❌       | Only redirects in this Redirection group.       | -         | `example`  |
| `page`     | `number` | ❌       | Page number, from 1 (default 1).                | `1`       | `example`  |
| `per_page` | `number` | ❌       | Redirects per page, 5 to 200 (default 50).      | `10`      | `10`, `20` |

## Examples

### Basic redirection Usage

Simple example of using wp_redirection_list_redirects

**Command:**

```bash
wp_redirection_list_redirects
```

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "Example redirection 1",
      "status": "publish"
    },
    {
      "id": 2,
      "title": "Example redirection 2",
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

### Multi-Site redirection Usage

Using wp_redirection_list_redirects with specific site targeting

**Command:**

```bash
wp_redirection_list_redirects --site="site1" --source="example_value"
```

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "Example redirection 1",
      "status": "publish"
    },
    {
      "id": 2,
      "title": "Example redirection 2",
      "status": "draft"
    }
  ],
  "total": 2,
  "pages": 1
}
```

### Advanced redirection Configuration

Comprehensive example using all available parameters

**Command:**

```bash
wp_redirection_list_redirects --source="example_value" --target="example_value" --status="publish" --group_id="example_value" --page="1" --per_page="10"
```

**Response:**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "title": "Example redirection 1",
      "status": "publish"
    },
    {
      "id": 2,
      "title": "Example redirection 2",
      "status": "draft"
    }
  ],
  "total": 2,
  "pages": 1
}
```

## Response Format

**Return Type:** `redirection[]`

```json
{
  "success": true,
  "data": {
    // redirection[] response data
  },
  "metadata": {
    "timestamp": "2024-01-01T00:00:00.000Z",
    "tool": "wp_redirection_list_redirects",
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
