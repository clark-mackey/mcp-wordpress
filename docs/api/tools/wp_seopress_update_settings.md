# wp_seopress_update_settings

![seopress](https://img.shields.io/badge/category-seopress-lightgrey)

Changes SEOPress global settings in one section (titles, social, sitemaps, or advanced). Read the section with
wp_seopress_get_settings first and pass only the keys to change: nested objects are merged, other values replaced, and
null removes a key (unchecks a SEOPress checkbox). Every other setting is kept. Checkboxes are stored as "1". The
advanced section also needs confirm_advanced: true. Reads the stored values back and fails if SEOPress did not store
what was sent, listing the previous values so the change can be undone.

## Parameters

| Parameter          | Type      | Required | Description                                                                                      | Default | Examples  |
| ------------------ | --------- | -------- | ------------------------------------------------------------------------------------------------ | ------- | --------- |
| `section`          | `string`  | ✅       | Settings section.                                                                                | -       | `example` |
| `changes`          | `object`  | ✅       | Keys to change, e.g. {"seopress_titles_sep": "\|"} or {"seopress_xml_sitemap_img_enable": null}. | -       | `example` |
| `confirm_advanced` | `boolean` | ❌       | Required (true) to change the advanced section, which includes SEOPress role restrictions.       | -       | `example` |

## Examples

### Basic seopress Usage

Simple example of using wp_seopress_update_settings

**Command:**

```bash
wp_seopress_update_settings --section="example_value" --changes="example_value"
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

Using wp_seopress_update_settings with specific site targeting

**Command:**

```bash
wp_seopress_update_settings --site="site1" --section="example_value"
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
wp_seopress_update_settings --section="example_value" --changes="example_value" --confirm_advanced="example_value"
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
    "tool": "wp_seopress_update_settings",
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
