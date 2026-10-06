# wp_redirection_list_groups

![redirection](https://img.shields.io/badge/category-redirection-lightgrey)

Lists Redirection groups with their IDs, module, enabled state, and redirect counts. Only groups in the WordPress module
redirect without exporting server rules.

## Parameters

_No parameters required._

## Examples

### Basic redirection Usage

Simple example of using wp_redirection_list_groups

**Command:**

```bash
wp_redirection_list_groups
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

Using wp_redirection_list_groups with specific site targeting

**Command:**

```bash
wp_redirection_list_groups --site="site1"
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
    "tool": "wp_redirection_list_groups",
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
