# wp_restore_revision

![revision](https://img.shields.io/badge/category-revision-lightgrey)

Restores a page or post to an earlier revision by copying that revision's title, content and excerpt back onto it. The
page keeps its current status, so a published page goes live with the restored content immediately. WordPress records
the restore as a new revision, so it can itself be undone. Get revision IDs from wp_get_page_revisions or
wp_get_post_revisions.

## Parameters

| Parameter     | Type     | Required | Description                                                         | Default | Examples  |
| ------------- | -------- | -------- | ------------------------------------------------------------------- | ------- | --------- |
| `post_type`   | `string` | ❌       | Whether the revision belongs to a page or a post. Defaults to page. | -       | `example` |
| `parent_id`   | `number` | ✅       | The ID of the page or post to restore.                              | -       | `example` |
| `revision_id` | `number` | ✅       | The ID of the revision to restore.                                  | -       | `example` |

## Examples

### Basic revision Usage

Simple example of using wp_restore_revision

**Command:**

```bash
wp_restore_revision --parent_id="example_value" --revision_id="example_value"
```

**Response:**

```json
{
  "success": true,
  "data": {},
  "message": "wp_restore_revision executed successfully"
}
```

**Error Example (Authentication failure):**

```json
{
  "error": "Authentication failed",
  "message": "Invalid credentials or insufficient permissions"
}
```

### Multi-Site revision Usage

Using wp_restore_revision with specific site targeting

**Command:**

```bash
wp_restore_revision --site="site1" --post_type="example_value"
```

**Response:**

```json
{
  "success": true,
  "data": {},
  "message": "wp_restore_revision executed successfully"
}
```

### Advanced revision Configuration

Comprehensive example using all available parameters

**Command:**

```bash
wp_restore_revision --post_type="example_value" --parent_id="example_value" --revision_id="example_value"
```

**Response:**

```json
{
  "success": true,
  "data": {},
  "message": "wp_restore_revision executed successfully"
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
    "tool": "wp_restore_revision",
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
