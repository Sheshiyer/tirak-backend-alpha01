# Password Reset API Documentation

## Overview
This document describes the password reset functionality in the Tirak platform. The system provides two endpoints: one to request a password reset and another to complete the reset process using a secure token.

## Endpoints

### 1. Request Password Reset

**URL:** `POST /api/auth/forgot-password`  
**Method:** `POST`  
**Authentication:** Not required  
**Rate Limited:** Yes (prevents spam)

### 2. Reset Password

**URL:** `POST /api/auth/reset-password`  
**Method:** `POST`  
**Authentication:** Not required (uses reset token)

## Request Password Reset

### Request Headers

| Header | Type | Required | Description |
|--------|------|----------|-------------|
| `Content-Type` | String | Yes | Must be `application/json` |

### Request Body Schema

```json
{
  "identifier": "string (required)"
}
```

### Field Validation Rules

| Field | Type | Validation Rules |
|-------|------|------------------|
| `identifier` | String | Min: 1 character (email or phone number) |

### Response Schema

#### Success Response (200 OK)

```json
{
  "success": true,
  "data": {
    "sent": true
  },
  "message": "If an account exists, a reset code will be sent"
}
```

#### Error Responses

##### 400 Bad Request - Validation Error
```json
{
  "success": false,
  "error": "Validation failed",
  "message": "Email or phone is required"
}
```

##### 429 Too Many Requests
```json
{
  "success": false,
  "error": "Rate limit exceeded",
  "message": "Too many password reset attempts"
}
```

##### 500 Internal Server Error
```json
{
  "success": false,
  "error": "Reset request failed",
  "message": "An error occurred while processing reset request"
}
```

## Reset Password

### Request Headers

| Header | Type | Required | Description |
|--------|------|----------|-------------|
| `Content-Type` | String | Yes | Must be `application/json` |

### Request Body Schema

```json
{
  "token": "string (required)",
  "newPassword": "string (required)"
}
```

### Field Validation Rules

| Field | Type | Validation Rules |
|-------|------|------------------|
| `token` | String | Min: 1 character (reset token from email/SMS) |
| `newPassword` | String | Min: 8 characters |

### Response Schema

#### Success Response (200 OK)

```json
{
  "success": true,
  "data": {
    "reset": true
  },
  "message": "Password reset successfully"
}
```

#### Error Responses

##### 400 Bad Request - Invalid Token
```json
{
  "success": false,
  "error": "Invalid token",
  "message": "Reset token is invalid or has expired"
}
```

##### 400 Bad Request - Token Expired
```json
{
  "success": false,
  "error": "Token expired",
  "message": "Reset token has expired"
}
```

##### 400 Bad Request - Validation Error
```json
{
  "success": false,
  "error": "Validation failed",
  "message": "Password must be at least 8 characters"
}
```

##### 500 Internal Server Error
```json
{
  "success": false,
  "error": "Reset failed",
  "message": "An error occurred while resetting password"
}
```

## Example Requests

### Example 1: Request Password Reset with Email

**cURL Request:**
```bash
curl -X POST "https://tirak-backend.tirak-court.workers.dev/api/auth/forgot-password" \
  -H "Content-Type: application/json" \
  -d '{
    "identifier": "user@example.com"
  }'
```

**Request Body:**
```json
{
  "identifier": "user@example.com"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "sent": true
  },
  "message": "If an account exists, a reset code will be sent"
}
```

### Example 2: Request Password Reset with Phone

**cURL Request:**
```bash
curl -X POST "https://tirak-backend.tirak-court.workers.dev/api/auth/forgot-password" \
  -H "Content-Type: application/json" \
  -d '{
    "identifier": "+66812345678"
  }'
```

**Request Body:**
```json
{
  "identifier": "+66812345678"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "sent": true
  },
  "message": "If an account exists, a reset code will be sent"
}
```

### Example 3: Reset Password with Valid Token

**cURL Request:**
```bash
curl -X POST "https://tirak-backend.tirak-court.workers.dev/api/auth/reset-password" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "123e4567-e89b-12d3-a456-426614174000",
    "newPassword": "newSecurePassword123"
  }'
```

**Request Body:**
```json
{
  "token": "123e4567-e89b-12d3-a456-426614174000",
  "newPassword": "newSecurePassword123"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "reset": true
  },
  "message": "Password reset successfully"
}
```

### Example 4: Reset Password with Different Token

**cURL Request:**
```bash
curl -X POST "https://tirak-backend.tirak-court.workers.dev/api/auth/reset-password" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "456e7890-e89b-12d3-a456-426614174001",
    "newPassword": "anotherSecurePassword456"
  }'
```

**Request Body:**
```json
{
  "token": "456e7890-e89b-12d3-a456-426614174001",
  "newPassword": "anotherSecurePassword456"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "reset": true
  },
  "message": "Password reset successfully"
}
```

## Error Examples

### Example 5: Invalid Reset Token

**cURL Request:**
```bash
curl -X POST "https://tirak-backend.tirak-court.workers.dev/api/auth/reset-password" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "invalid-token-123",
    "newPassword": "newPassword123"
  }'
```

**Response:**
```json
{
  "success": false,
  "error": "Invalid token",
  "message": "Reset token is invalid or has expired"
}
```

### Example 6: Expired Reset Token

**cURL Request:**
```bash
curl -X POST "https://tirak-backend.tirak-court.workers.dev/api/auth/reset-password" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "expired-token-123",
    "newPassword": "newPassword123"
  }'
```

**Response:**
```json
{
  "success": false,
  "error": "Token expired",
  "message": "Reset token has expired"
}
```

### Example 7: Weak Password

**cURL Request:**
```bash
curl -X POST "https://tirak-backend.tirak-court.workers.dev/api/auth/reset-password" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "valid-token-123",
    "newPassword": "123"
  }'
```

**Response:**
```json
{
  "success": false,
  "error": "Validation failed",
  "message": "Password must be at least 8 characters"
}
```

### Example 8: Missing Identifier

**cURL Request:**
```bash
curl -X POST "https://tirak-backend.tirak-court.workers.dev/api/auth/forgot-password" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Response:**
```json
{
  "success": false,
  "error": "Validation failed",
  "message": "Email or phone is required"
}
```

### Example 9: Rate Limit Exceeded

**cURL Request:**
```bash
# Multiple rapid requests (after hitting rate limit)
curl -X POST "https://tirak-backend.tirak-court.workers.dev/api/auth/forgot-password" \
  -H "Content-Type: application/json" \
  -d '{
    "identifier": "user@example.com"
  }'
```

**Response:**
```json
{
  "success": false,
  "error": "Rate limit exceeded",
  "message": "Too many password reset attempts"
}
```

## Complete Password Reset Flow

### Step 1: User Requests Reset

```bash
curl -X POST "https://tirak-backend.tirak-court.workers.dev/api/auth/forgot-password" \
  -H "Content-Type: application/json" \
  -d '{
    "identifier": "user@example.com"
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "sent": true
  },
  "message": "If an account exists, a reset code will be sent"
}
```

### Step 2: User Receives Token

The system generates a secure token and stores it in cache for 1 hour. In development, the token is logged to console. In production, it would be sent via email/SMS.

**Development Console Output:**
```
Password reset token for user@example.com: 123e4567-e89b-12d3-a456-426614174000
```

### Step 3: User Resets Password

```bash
curl -X POST "https://tirak-backend.tirak-court.workers.dev/api/auth/reset-password" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "123e4567-e89b-12d3-a456-426614174000",
    "newPassword": "newSecurePassword123"
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "reset": true
  },
  "message": "Password reset successfully"
}
```

## Security Features

### Token Security
- **Secure Generation:** Uses `crypto.randomUUID()` for token generation
- **Time Expiration:** Tokens expire after 1 hour
- **Single Use:** Tokens are deleted after successful password reset
- **Cache Storage:** Tokens stored in secure cache with TTL

### Rate Limiting
- **Protection:** Prevents spam and brute force attacks
- **Configurable:** Rate limits can be adjusted in middleware
- **Per IP:** Limits applied per IP address

### Privacy Protection
- **No User Enumeration:** Same response whether user exists or not
- **Secure Messaging:** Generic success message prevents information leakage

### Password Security
- **Hashing:** Passwords are hashed using bcrypt before storage
- **Minimum Length:** 8 character minimum requirement
- **No Storage:** Plain text passwords are never stored

## Development vs Production

### Development Mode
- Reset tokens are logged to console
- No actual email/SMS sending
- Useful for testing and debugging

### Production Mode
- Reset tokens sent via email/SMS
- No console logging of sensitive data
- Full communication system integration

## Notes

- The system supports both email and phone number identifiers
- Reset tokens are valid for exactly 1 hour
- Each token can only be used once
- The system doesn't reveal whether a user account exists
- All password resets are tracked for analytics
- Rate limiting prevents abuse of the reset system

## Related Endpoints

- `POST /api/auth/login` - User login
- `POST /api/auth/register` - User registration
- `POST /api/auth/logout` - User logout
- `POST /api/auth/verify-phone` - Phone verification
