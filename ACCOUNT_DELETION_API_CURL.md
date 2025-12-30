# Account Deletion API - cURL Requests

## Base URL
Replace `https://your-api-domain.com` with your actual API domain (e.g., `https://tirak-api.workers.dev` or `http://localhost:8787` for local development)

## Authentication
All endpoints require JWT Bearer token authentication. Replace `YOUR_JWT_TOKEN` with a valid JWT token obtained from the login endpoint.

---

## 1. General User Account Deletion
**Endpoint:** `DELETE /api/users/:id`  
**Description:** Allows any authenticated user to delete their own account (soft delete)

```bash
curl -X DELETE \
  'https://your-api-domain.com/api/users/YOUR_USER_ID' \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN' \
  -H 'Content-Type: application/json'
```

**Example:**
```bash
curl -X DELETE \
  'https://your-api-domain.com/api/users/550e8400-e29b-41d4-a716-446655440000' \
  -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json'
```

---

## 2. Customer Account Deletion
**Endpoint:** `DELETE /api/customers/:id`  
**Description:** Allows customers to delete their own account (soft delete with booking cancellation)

```bash
curl -X DELETE \
  'https://your-api-domain.com/api/customers/YOUR_CUSTOMER_ID' \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN' \
  -H 'Content-Type: application/json'
```

**Example:**
```bash
curl -X DELETE \
  'https://your-api-domain.com/api/customers/550e8400-e29b-41d4-a716-446655440000' \
  -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json'
```

**Note:** Only customers can delete their own account. The endpoint will:
- Cancel any pending bookings
- Delete user sessions
- Soft delete the account (anonymize email/phone, set status to 'deleted')

---

## 3. Supplier Account Deletion
**Endpoint:** `DELETE /api/suppliers/:id`  
**Description:** Allows suppliers to delete their own account (soft delete with comprehensive cleanup)

```bash
curl -X DELETE \
  'https://your-api-domain.com/api/suppliers/YOUR_SUPPLIER_ID' \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN' \
  -H 'Content-Type: application/json'
```

**Example:**
```bash
curl -X DELETE \
  'https://your-api-domain.com/api/suppliers/550e8400-e29b-41d4-a716-446655440000' \
  -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json'
```

**Note:** Only suppliers can delete their own account. The endpoint will:
- Cancel pending bookings
- Soft delete supplier profile
- Soft delete all services
- Delete availability
- Delete user sessions
- Clear cache
- Soft delete the account (anonymize email/phone, set status to 'suspended')

---

## 4. Companion Account Deletion
**Endpoint:** `DELETE /api/companions/:id`  
**Description:** Allows companions to delete their own profile (soft delete with comprehensive cleanup)

```bash
curl -X DELETE \
  'https://your-api-domain.com/api/companions/YOUR_COMPANION_ID' \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN' \
  -H 'Content-Type: application/json'
```

**Example:**
```bash
curl -X DELETE \
  'https://your-api-domain.com/api/companions/550e8400-e29b-41d4-a716-446655440000' \
  -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json'
```

**Note:** Only companions can delete their own profile. The endpoint will:
- Soft delete companion profile
- Soft delete all experiences
- Delete locations
- Delete availability
- Cancel pending bookings
- Delete user sessions
- Soft delete the account (anonymize email/phone, set status to 'suspended')

---

## 5. Admin User Deletion (Hard Delete)
**Endpoint:** `DELETE /api/admin/users/:userId`  
**Description:** Allows admins to delete any user account (hard delete - permanent removal)

```bash
curl -X DELETE \
  'https://your-api-domain.com/api/admin/users/USER_ID_TO_DELETE' \
  -H 'Authorization: Bearer YOUR_ADMIN_JWT_TOKEN' \
  -H 'Content-Type: application/json'
```

**Example:**
```bash
curl -X DELETE \
  'https://your-api-domain.com/api/admin/users/550e8400-e29b-41d4-a716-446655440000' \
  -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' \
  -H 'Content-Type: application/json'
```

**Note:** This endpoint requires admin privileges. The endpoint will:
- Hard delete profile data (customer/supplier)
- Delete user sessions
- Permanently delete user from database
- Log admin action
- Track analytics event

**⚠️ Warning:** This is a hard delete operation that permanently removes data from the database. Use with caution.

---

## Expected Responses

### Success Response (200 OK)
```json
{
  "success": true,
  "data": {
    "deleted": true
  },
  "message": "Account deleted successfully"
}
```

### Error Responses

**401 Unauthorized:**
```json
{
  "success": false,
  "error": "Authentication failed",
  "message": "Invalid token"
}
```

**403 Forbidden:**
```json
{
  "success": false,
  "error": "Access denied",
  "message": "You can only delete your own account"
}
```

**404 Not Found:**
```json
{
  "success": false,
  "error": "User not found",
  "message": "The requested user does not exist"
}
```

**500 Internal Server Error:**
```json
{
  "success": false,
  "error": "Failed to delete account",
  "message": "An error occurred while deleting the account"
}
```

---

## Getting a JWT Token

To obtain a JWT token, first authenticate using the login endpoint:

```bash
curl -X POST \
  'https://your-api-domain.com/api/auth/login' \
  -H 'Content-Type: application/json' \
  -d '{
    "email": "user@example.com",
    "password": "your-password"
  }'
```

The response will include an `accessToken` that you can use in the Authorization header.

---

## Testing with Local Development

If running locally with `npm run dev`, use:
```bash
curl -X DELETE \
  'http://localhost:8787/api/users/YOUR_USER_ID' \
  -H 'Authorization: Bearer YOUR_JWT_TOKEN' \
  -H 'Content-Type: application/json'
```

