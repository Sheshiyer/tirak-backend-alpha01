# API Schema Documentation

## Base Configuration
```
Base URL: https://api.tirak.com/v1
Content-Type: application/json
Authorization: Bearer {token}
```

## Authentication Endpoints

### POST /auth/register
**Request:**
```json
{
  "name": "string",
  "email": "string",
  "password": "string",
  "role": "customer" | "companion",
  "phone": "string?",
  "dateOfBirth": "string?",
  "gender": "male" | "female" | "other"?
}
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "user": {
      "id": "string",
      "name": "string",
      "email": "string",
      "role": "customer" | "companion",
      "verified": boolean,
      "createdAt": "string",
      "profileImage": "string?",
      "phone": "string?",
      "dateOfBirth": "string?",
      "gender": "string?"
    },
    "token": "string",
    "refreshToken": "string"
  },
  "message": "string"
}
```

### POST /auth/login
**Request:**
```json
{
  "email": "string",
  "password": "string"
}
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "user": {
      "id": "string",
      "name": "string",
      "email": "string",
      "role": "customer" | "companion",
      "verified": boolean,
      "createdAt": "string",
      "profileImage": "string?",
      "phone": "string?",
      "onboarded": boolean
    },
    "token": "string",
    "refreshToken": "string"
  },
  "message": "string"
}
```

### POST /auth/refresh
**Request:**
```json
{
  "refreshToken": "string"
}
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "token": "string",
    "refreshToken": "string"
  }
}
```

### POST /auth/logout
**Request:**
```json
{
  "refreshToken": "string"
}
```

**Response:**
```json
{
  "success": boolean,
  "message": "string"
}
```

### POST /auth/forgot-password
**Request:**
```json
{
  "email": "string"
}
```

**Response:**
```json
{
  "success": boolean,
  "message": "string"
}
```

### POST /auth/reset-password
**Request:**
```json
{
  "token": "string",
  "password": "string"
}
```

**Response:**
```json
{
  "success": boolean,
  "message": "string"
}
```

## User Profile Endpoints

### GET /users/profile
**Response:**
```json
{
  "success": boolean,
  "data": {
    "id": "string",
    "name": "string",
    "email": "string",
    "role": "customer" | "companion",
    "verified": boolean,
    "profileImage": "string?",
    "phone": "string?",
    "dateOfBirth": "string?",
    "gender": "string?",
    "preferences": {
      "language": "string",
      "currency": "string",
      "notifications": {
        "push": boolean,
        "email": boolean,
        "sms": boolean
      }
    },
    "createdAt": "string",
    "updatedAt": "string"
  }
}
```

### PUT /users/profile
**Request:**
```json
{
  "name": "string?",
  "displayName": "string?",
  "bio": "string?",
  "socialLinks": {
    "instagram": "string?",
    "facebook": "string?",
    "twitter": "string?",
    "tiktok": "string?",
    "website": "string?",
    "other": [{"name": "string", "url": "string"}]?
  },
  "dateOfBirth": "string?",
  "gender": "male" | "female" | "other"?,
  "profileImage": "string?",
  "preferences": {
    "language": "string?",
    "currency": "string?",
    "notifications": {
      "push": true,
      "email": true,
      "sms": true
    }?
  }?
}
```
**Response:**
```json
{
  "success": true,
  "data": {
    "id": "string",
    "name": "string",
    "displayName": "string",
    "email": "string",
    "role": "customer" | "companion",
    "verified": true,
    "profileImage": "string?",
    "phone": "string?",
    "bio": "string?",
    "socialLinks": {},
    "dateOfBirth": "string?",
    "gender": "string?",
    "preferences": {
      "language": "string",
      "currency": "string",
      "notifications": {
        "push": true,
        "email": true,
        "sms": true
      }
    },
    "createdAt": "string",
    "updatedAt": "string"
  },
  "message": "Profile updated successfully"
}
```

### GET /users/:id
**Response:**
```json
{
  "success": true,
  "data": {
    "user": { /* user fields */ },
    "profile": { /* profile fields */ }
  },
  "message": "Profile retrieved successfully"
}
```

## Companion/Supplier Endpoints

### GET /companions
**Query Parameters:**
```
search?: string
category?: string
location?: string
minPrice?: number
maxPrice?: number
rating?: number
languages?: string[] (comma-separated)
available?: boolean
verified?: boolean
page?: number
limit?: number
sortBy?: "rating" | "price" | "distance" | "reviews"
sortOrder?: "asc" | "desc"
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "companions": [
      {
        "id": "string",
        "name": "string",
        "displayName": "string",
        "profileImage": "string",
        "gallery": ["string"],
        "location": "string",
        "rating": number,
        "reviewCount": number,
        "price": number,
        "services": ["string"],
        "languages": ["string"],
        "verified": boolean,
        "online": boolean,
        "categories": ["string"],
        "bio": "string?",
        "age": number?,
        "responseTime": "string",
        "completionRate": number,
        "distance": number?
      }
    ],
    "pagination": {
      "page": number,
      "limit": number,
      "total": number,
      "totalPages": number
    },
    "filters": {
      "categories": [{"id": "string", "name": "string", "count": number}],
      "locations": [{"id": "string", "name": "string", "count": number}],
      "priceRange": {"min": number, "max": number},
      "languages": [{"id": "string", "name": "string", "count": number}]
    }
  }
}
```

### GET /companions/{id}
**Response:**
```json
{
  "success": boolean,
  "data": {
    "id": "string",
    "name": "string",
    "displayName": "string",
    "profileImage": "string",
    "gallery": ["string"],
    "location": "string",
    "rating": number,
    "reviewCount": number,
    "price": number,
    "services": [
      {
        "id": "string",
        "name": "string",
        "description": "string",
        "price": number,
        "duration": "string",
        "category": "string"
      }
    ],
    "languages": ["string"],
    "verified": boolean,
    "online": boolean,
    "lastSeen": "string?",
    "categories": ["string"],
    "bio": "string",
    "age": number,
    "responseTime": "string",
    "completionRate": number,
    "joinedDate": "string",
    "availability": {
      "weeklySchedule": {
        "monday": [{"start": "string", "end": "string"}],
        "tuesday": [{"start": "string", "end": "string"}],
        "wednesday": [{"start": "string", "end": "string"}],
        "thursday": [{"start": "string", "end": "string"}],
        "friday": [{"start": "string", "end": "string"}],
        "saturday": [{"start": "string", "end": "string"}],
        "sunday": [{"start": "string", "end": "string"}]
      },
      "exceptions": [
        {
          "date": "string",
          "available": boolean,
          "reason": "string?"
        }
      ]
    },
    "reviews": [
      {
        "id": "string",
        "user": {
          "id": "string",
          "name": "string",
          "profileImage": "string?"
        },
        "rating": number,
        "comment": "string",
        "date": "string",
        "verified": boolean
      }
    ]
  }
}
```

### GET /companions/{id}/availability
**Query Parameters:**
```
startDate: string (YYYY-MM-DD)
endDate: string (YYYY-MM-DD)
```

**Response:**
```json
{
  "success": true,
  "data": {
    "availability": [
      {
        "date": "YYYY-MM-DD",
        "available": true,
        "slots": [
          {
            "start": "HH:MM",
            "end": "HH:MM",
            "available": true
          }
        ]
      }
    ]
  },
  "message": "Availability retrieved successfully"
}
```

### POST /companions/:id/availability
**Request:**
```json
[
  {
    "dayOfWeek": 1,
    "startTime": "09:00",
    "endTime": "17:00",
    "isAvailable": true
  }
]
```
**Response:**
```json
{
  "success": true,
  "data": { "updated": true },
  "message": "Availability updated successfully"
}
```

### PUT /companions/profile
**Request:** (multipart/form-data or application/json)

- **multipart/form-data**
  - Fields:
    - `coverPhoto`: File (optional, cover photo image)
    - `profilePhoto`: File (optional, profile photo image)
    - `data`: JSON string with the following fields:
      ```json
      {
        "firstName": "string?",
        "lastName": "string?",
        "displayName": "string?",
        "bio": "string?",
        "socialLinks": {
          "instagram": "string?",
          "facebook": "string?",
          "twitter": "string?",
          "tiktok": "string?",
          "website": "string?",
          "other": [{"name": "string", "url": "string"}]?
        },
        "dateOfBirth": "string?",
        "gender": "male" | "female" | "other"?
      }
      ```
- **application/json**
  - Body:
    ```json
    {
      "firstName": "string?",
      "lastName": "string?",
      "displayName": "string?",
      "bio": "string?",
      "socialLinks": {
        "instagram": "string?",
        "facebook": "string?",
        "twitter": "string?",
        "tiktok": "string?",
        "website": "string?",
        "other": [{"name": "string", "url": "string"}]?
      },
      "dateOfBirth": "string?",
      "gender": "male" | "female" | "other"?
    }
    ```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "string",
    "firstName": "string",
    "lastName": "string",
    "displayName": "string",
    "coverPhoto": "string?",
    "profilePhoto": "string?",
    "bio": "string?",
    "socialLinks": {},
    "dateOfBirth": "string?",
    "gender": "string?",
    "updatedAt": "string"
  },
  "message": "Companion profile updated successfully"
}
```

### GET /suppliers/profile
**Response:**
```json
{
  "success": boolean,
  "data": {
    "id": "string",
    "displayName": "string",
    "profileImage": "string",
    "gallery": ["string"],
    "bio": "string",
    "location": "string",
    "rating": number,
    "reviewCount": number,
    "status": "pending" | "approved" | "suspended",
    "verified": boolean,
    "joinedDate": "string",
    "categories": ["string"],
    "regions": ["string"],
    "services": [
      {
        "id": "string",
        "name": "string",
        "description": "string",
        "price": number,
        "duration": "string",
        "category": "string",
        "active": boolean
      }
    ],
    "availability": {
      "weeklySchedule": {
        "monday": [{"start": "string", "end": "string"}],
        "tuesday": [{"start": "string", "end": "string"}],
        "wednesday": [{"start": "string", "end": "string"}],
        "thursday": [{"start": "string", "end": "string"}],
        "friday": [{"start": "string", "end": "string"}],
        "saturday": [{"start": "string", "end": "string"}],
        "sunday": [{"start": "string", "end": "string"}]
      },
      "exceptions": [
        {
          "date": "string",
          "available": boolean,
          "reason": "string?"
        }
      ]
    },
    "subscription": {
      "plan": "basic" | "premium" | "pro",
      "status": "active" | "expired" | "cancelled",
      "expiresAt": "string",
      "features": ["string"]
    }
  }
}
```

### PUT /suppliers/profile
**Request:**
```json
{
  "displayName": "string?",
  "bio": "string?",
  "profileImage": "string?",
  "gallery": ["string"]?,
  "categories": ["string"]?,
  "regions": ["string"]?
}
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "profile": "SupplierProfile"
  },
  "message": "string"
}
```

### GET /suppliers/stats
**Response:**
```json
{
  "success": boolean,
  "data": {
    "totalBookings": number,
    "completedBookings": number,
    "cancelledBookings": number,
    "totalEarnings": number,
    "thisMonthEarnings": number,
    "lastMonthEarnings": number,
    "profileViews": number,
    "responseRate": number,
    "averageRating": number,
    "totalReviews": number,
    "monthlyStats": [
      {
        "month": "string",
        "bookings": number,
        "earnings": number,
        "rating": number
      }
    ]
  }
}
```

### POST /suppliers/services
**Request:**
```json
{
  "name": "string",
  "description": "string",
  "price": number,
  "duration": "string",
  "category": "string"
}
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "service": {
      "id": "string",
      "name": "string",
      "description": "string",
      "price": number,
      "duration": "string",
      "category": "string",
      "active": boolean,
      "createdAt": "string"
    }
  },
  "message": "string"
}
```

### PUT /suppliers/services/{id}
**Request:**
```json
{
  "name": "string?",
  "description": "string?",
  "price": number?,
  "duration": "string?",
  "category": "string?",
  "active": boolean?
}
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "service": "Service"
  },
  "message": "string"
}
```

### DELETE /suppliers/services/{id}
**Response:**
```json
{
  "success": boolean,
  "message": "string"
}
```

### PUT /suppliers/availability
**Request:**
```json
{
  "weeklySchedule": {
    "monday": [{"start": "string", "end": "string"}],
    "tuesday": [{"start": "string", "end": "string"}],
    "wednesday": [{"start": "string", "end": "string"}],
    "thursday": [{"start": "string", "end": "string"}],
    "friday": [{"start": "string", "end": "string"}],
    "saturday": [{"start": "string", "end": "string"}],
    "sunday": [{"start": "string", "end": "string"}]
  },
  "exceptions": [
    {
      "date": "string",
      "available": boolean,
      "reason": "string?"
    }
  ]
}
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "availability": "Availability"
  },
  "message": "string"
}
```

### PUT /suppliers/:id
**Request:**
```json
{
  "displayName": "string",
  "bio": "string?",
  "categories": ["string"],
  "regions": ["string"],
  "spokenLanguages": ["string"],
  "profileImages": ["string"]
}
```
**Response:**
```json
{
  "success": true,
  "data": { "updated": true },
  "message": "Supplier profile updated successfully"
}
```

### GET /suppliers/:id/services
**Response:**
```json
{
  "success": true,
  "data": {
    "services": [
      {
        "id": "string",
        "title": "string",
        "description": "string",
        "priceMin": 0,
        "priceMax": 0,
        "currency": "string",
        "durationHours": 0,
        "isActive": true,
        "createdAt": "string",
        "updatedAt": "string"
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 100, "totalPages": 5 }
  },
  "message": "Services retrieved successfully"
}
```

## Booking Endpoints

### POST /bookings
**Request:**
```json
{
  "companionId": "string",
  "serviceId": "string?",
  "date": "string",
  "startTime": "string",
  "endTime": "string",
  "duration": number,
  "location": "string?",
  "specialRequests": "string?",
  "paymentMethodId": "string"
}
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "booking": {
      "id": "string",
      "companionId": "string",
      "companion": {
        "id": "string",
        "name": "string",
        "profileImage": "string"
      },
      "customerId": "string",
      "serviceId": "string?",
      "service": {
        "id": "string",
        "name": "string",
        "price": number
      }?,
      "date": "string",
      "startTime": "string",
      "endTime": "string",
      "duration": number,
      "location": "string?",
      "specialRequests": "string?",
      "status": "pending" | "confirmed" | "in_progress" | "completed" | "cancelled",
      "totalAmount": number,
      "serviceFee": number,
      "paymentStatus": "pending" | "paid" | "refunded",
      "createdAt": "string",
      "updatedAt": "string"
    }
  },
  "message": "string"
}
```

### GET /bookings
**Query Parameters:**
```
status?: "pending" | "confirmed" | "in_progress" | "completed" | "cancelled"
page?: number
limit?: number
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "bookings": [
      {
        "id": "string",
        "companion": {
          "id": "string",
          "name": "string",
          "profileImage": "string",
          "rating": number
        },
        "service": {
          "id": "string",
          "name": "string",
          "price": number
        }?,
        "date": "string",
        "startTime": "string",
        "endTime": "string",
        "duration": number,
        "location": "string?",
        "status": "string",
        "totalAmount": number,
        "paymentStatus": "string",
        "createdAt": "string"
      }
    ],
    "pagination": {
      "page": number,
      "limit": number,
      "total": number,
      "totalPages": number
    }
  }
}
```

### GET /bookings/{id}
**Response:**
```json
{
  "success": boolean,
  "data": {
    "booking": {
      "id": "string",
      "companion": {
        "id": "string",
        "name": "string",
        "profileImage": "string",
        "phone": "string",
        "rating": number
      },
      "customer": {
        "id": "string",
        "name": "string",
        "profileImage": "string",
        "phone": "string"
      },
      "service": {
        "id": "string",
        "name": "string",
        "description": "string",
        "price": number
      }?,
      "date": "string",
      "startTime": "string",
      "endTime": "string",
      "duration": number,
      "location": "string?",
      "specialRequests": "string?",
      "status": "string",
      "totalAmount": number,
      "serviceFee": number,
      "paymentStatus": "string",
      "paymentMethod": {
        "id": "string",
        "type": "string",
        "last4": "string?"
      },
      "timeline": [
        {
          "status": "string",
          "timestamp": "string",
          "note": "string?"
        }
      ],
      "createdAt": "string",
      "updatedAt": "string"
    }
  }
}
```

### PUT /bookings/{id}/status
**Request:**
```json
{
  "status": "confirmed" | "cancelled" | "completed",
  "reason": "string?"
}
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "booking": "Booking"
  },
  "message": "string"
}
```

## Chat/Messaging Endpoints

### GET /conversations
**Response:**
```json
{
  "success": boolean,
  "data": {
    "conversations": [
      {
        "id": "string",
        "participant": {
          "id": "string",
          "name": "string",
          "profileImage": "string",
          "online": boolean,
          "lastSeen": "string?"
        },
        "lastMessage": {
          "id": "string",
          "text": "string",
          "sender": "string",
          "timestamp": "string",
          "type": "text" | "image" | "audio"
        },
        "unreadCount": number,
        "updatedAt": "string"
      }
    ]
  }
}
```

### GET /conversations/{id}/messages
**Query Parameters:**
```
page?: number
limit?: number
before?: string (message ID)
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "messages": [
      {
        "id": "string",
        "conversationId": "string",
        "senderId": "string",
        "text": "string",
        "type": "text" | "image" | "audio",
        "mediaUrl": "string?",
        "timestamp": "string",
        "status": "sent" | "delivered" | "read",
        "replyTo": "string?"
      }
    ],
    "pagination": {
      "page": number,
      "limit": number,
      "hasMore": boolean
    }
  }
}
```

### POST /conversations/{id}/messages
**Request:**
```json
{
  "text": "string?",
  "type": "text" | "image" | "audio",
  "mediaUrl": "string?",
  "replyTo": "string?"
}
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "message": {
      "id": "string",
      "conversationId": "string",
      "senderId": "string",
      "text": "string",
      "type": "string",
      "mediaUrl": "string?",
      "timestamp": "string",
      "status": "sent"
    }
  }
}
```

### PUT /conversations/{id}/read
**Request:**
```json
{
  "messageId": "string"
}
```

**Response:**
```json
{
  "success": boolean,
  "message": "string"
}
```

### POST /conversations
**Request:**
```json
{
  "participantId": "string",
  "initialMessage": "string?"
}
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "conversation": {
      "id": "string",
      "participant": {
        "id": "string",
        "name": "string",
        "profileImage": "string"
      },
      "createdAt": "string"
    }
  }
}
```

## Reviews Endpoints

### POST /reviews
**Request:**
```json
{
  "bookingId": "string",
  "companionId": "string",
  "rating": number,
  "comment": "string",
  "categories": {
    "communication": number,
    "punctuality": number,
    "professionalism": number,
    "knowledge": number
  }?
}
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "review": {
      "id": "string",
      "bookingId": "string",
      "companionId": "string",
      "customerId": "string",
      "rating": number,
      "comment": "string",
      "categories": {
        "communication": number,
        "punctuality": number,
        "professionalism": number,
        "knowledge": number
      },
      "verified": boolean,
      "createdAt": "string"
    }
  },
  "message": "string"
}
```

### GET /reviews/companion/{id}
**Query Parameters:**
```
page?: number
limit?: number
rating?: number
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "reviews": [
      {
        "id": "string",
        "customer": {
          "id": "string",
          "name": "string",
          "profileImage": "string?"
        },
        "rating": number,
        "comment": "string",
        "categories": {
          "communication": number,
          "punctuality": number,
          "professionalism": number,
          "knowledge": number
        },
        "verified": boolean,
        "createdAt": "string"
      }
    ],
    "pagination": {
      "page": number,
      "limit": number,
      "total": number,
      "totalPages": number
    },
    "summary": {
      "averageRating": number,
      "totalReviews": number,
      "ratingDistribution": {
        "5": number,
        "4": number,
        "3": number,
        "2": number,
        "1": number
      },
      "categoryAverages": {
        "communication": number,
        "punctuality": number,
        "professionalism": number,
        "knowledge": number
      }
    }
  }
}
```

## Payment Endpoints

### GET /payment-methods
**Response:**
```json
{
  "success": boolean,
  "data": {
    "paymentMethods": [
      {
        "id": "string",
        "type": "card" | "promptpay" | "truemoney" | "bank_transfer",
        "isDefault": boolean,
        "details": {
          "last4": "string?",
          "brand": "string?",
          "expiryMonth": number?,
          "expiryYear": number?,
          "holderName": "string?",
          "phoneNumber": "string?",
          "accountNumber": "string?"
        },
        "createdAt": "string"
      }
    ]
  }
}
```

### POST /payment-methods
**Request:**
```json
{
  "type": "card" | "promptpay" | "truemoney" | "bank_transfer",
  "details": {
    "cardNumber": "string?",
    "expiryMonth": number?,
    "expiryYear": number?,
    "cvv": "string?",
    "holderName": "string?",
    "phoneNumber": "string?",
    "accountNumber": "string?"
  },
  "isDefault": boolean?
}
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "paymentMethod": {
      "id": "string",
      "type": "string",
      "isDefault": boolean,
      "details": "PaymentMethodDetails"
    }
  },
  "message": "string"
}
```

### DELETE /payment-methods/{id}
**Response:**
```json
{
  "success": boolean,
  "message": "string"
}
```

### GET /payments/history
**Query Parameters:**
```
page?: number
limit?: number
status?: "pending" | "completed" | "failed" | "refunded"
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "payments": [
      {
        "id": "string",
        "bookingId": "string",
        "amount": number,
        "serviceFee": number,
        "totalAmount": number,
        "currency": "string",
        "status": "pending" | "completed" | "failed" | "refunded",
        "paymentMethod": {
          "type": "string",
          "last4": "string?"
        },
        "createdAt": "string",
        "completedAt": "string?"
      }
    ],
    "pagination": {
      "page": number,
      "limit": number,
      "total": number,
      "totalPages": number
    }
  }
}
```

## Notifications Endpoints

### GET /notifications
**Query Parameters:**
```
page?: number
limit?: number
read?: boolean
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "notifications": [
      {
        "id": "string",
        "type": "booking_confirmed" | "booking_cancelled" | "new_message" | "review_received" | "payment_completed",
        "title": "string",
        "message": "string",
        "data": {
          "bookingId": "string?",
          "conversationId": "string?",
          "reviewId": "string?",
          "paymentId": "string?"
        },
        "read": boolean,
        "createdAt": "string"
      }
    ],
    "pagination": {
      "page": number,
      "limit": number,
      "total": number,
      "totalPages": number
    },
    "unreadCount": number
  }
}
```

### PUT /notifications/{id}/read
**Response:**
```json
{
  "success": boolean,
  "message": "string"
}
```

### PUT /notifications/read-all
**Response:**
```json
{
  "success": boolean,
  "message": "string"
}
```

## File Upload Endpoints

### POST /upload/image
**Request:** (multipart/form-data)
```
file: File
type: "profile" | "gallery" | "verification" | "chat"
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "url": "string",
    "filename": "string",
    "size": number,
    "mimeType": "string"
  }
}
```

### POST /upload/multiple
**Request:** (multipart/form-data)
```
files: File[]
type: "gallery" | "verification"
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "urls": [
      {
        "url": "string",
        "filename": "string",
        "size": number,
        "mimeType": "string"
      }
    ]
  }
}
```

## Search & Discovery Endpoints

### GET /search/suggestions
**Query Parameters:**
```
query: string
type?: "companions" | "services" | "locations"
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "suggestions": [
      {
        "type": "companion" | "service" | "location",
        "id": "string",
        "text": "string",
        "subtitle": "string?",
        "image": "string?"
      }
    ]
  }
}
```

### GET /categories
**Response:**
```json
{
  "success": boolean,
  "data": {
    "categories": [
      {
        "id": "string",
        "name": "string",
        "icon": "string",
        "color": "string",
        "description": "string",
        "companionCount": number
      }
    ]
  }
}
```

### GET /locations
**Response:**
```json
{
  "success": boolean,
  "data": {
    "locations": [
      {
        "id": "string",
        "name": "string",
        "region": "string",
        "country": "string",
        "companionCount": number,
        "coordinates": {
          "latitude": number,
          "longitude": number
        }
      }
    ]
  }
}
```

## WebSocket Events (Real-time)

### Connection
```
URL: wss://api.tirak.com/ws
Authorization: Bearer {token}
```

### Events

#### Message Events
```json
// Incoming message
{
  "type": "message_received",
  "data": {
    "conversationId": "string",
    "message": "Message"
  }
}

// Typing indicator
{
  "type": "typing_start",
  "data": {
    "conversationId": "string",
    "userId": "string"
  }
}

{
  "type": "typing_stop",
  "data": {
    "conversationId": "string",
    "userId": "string"
  }
}

// Message status update
{
  "type": "message_status_update",
  "data": {
    "messageId": "string",
    "status": "delivered" | "read"
  }
}
```

#### Booking Events
```json
// Booking status update
{
  "type": "booking_status_update",
  "data": {
    "bookingId": "string",
    "status": "confirmed" | "cancelled" | "completed",
    "message": "string?"
  }
}

// New booking request (for companions)
{
  "type": "booking_request",
  "data": {
    "booking": "Booking"
  }
}
```

#### Notification Events
```json
// New notification
{
  "type": "notification",
  "data": {
    "notification": "Notification"
  }
}
```

#### Presence Events
```json
// User online/offline status
{
  "type": "user_presence_update",
  "data": {
    "userId": "string",
    "online": boolean,
    "lastSeen": "string?"
  }
}
```

## Error Response Format

All endpoints return errors in this format:

```json
{
  "success": false,
  "error": {
    "code": "string",
    "message": "string",
    "details": "any?"
  }
}
```

### Common Error Codes
- `UNAUTHORIZED` - Invalid or missing authentication token
- `FORBIDDEN` - User doesn't have permission for this action
- `NOT_FOUND` - Resource not found
- `VALIDATION_ERROR` - Request validation failed
- `RATE_LIMIT_EXCEEDED` - Too many requests
- `INTERNAL_ERROR` - Server error
- `PAYMENT_FAILED` - Payment processing failed
- `BOOKING_CONFLICT` - Time slot already booked
- `INSUFFICIENT_FUNDS` - Not enough balance for transaction

### HTTP Status Codes
- `200` - Success
- `201` - Created
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `409` - Conflict
- `422` - Validation Error
- `429` - Rate Limit Exceeded
- `500` - Internal Server Error

## [ADDED] Companion Endpoints

### POST /companions/:id/experiences
**Request:**
```json
{
  "title": "string",
  "description": "string?",
  "durationMinutes": 60,
  "keywords": ["string"],
  "price": 1000,
  "currency": "string"
}
```
**Response:**
```json
{
  "success": true,
  "data": {
    "experienceId": "string",
    "created": true
  },
  "message": "Experience created successfully"
}
```

### GET /companions/:id/experiences
**Response:**
```json
{
  "success": true,
  "data": {
    "experiences": [
      {
        "id": "string",
        "title": "string",
        "description": "string",
        "durationMinutes": 60,
        "keywords": ["string"],
        "price": 1000,
        "currency": "string",
        "isActive": true,
        "createdAt": "string",
        "updatedAt": "string"
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 100, "totalPages": 5 }
  },
  "message": "Experiences retrieved successfully"
}
```

### GET /companions/:id/locations
**Response:**
```json
{
  "success": true,
  "data": {
    "locations": [
      {
        "id": "string",
        "city": "string",
        "region": "string",
        "isPopular": true,
        "description": "string",
        "createdAt": "string",
        "updatedAt": "string"
      }
    ],
    "pagination": { "page": 1, "limit": 20, "total": 100, "totalPages": 5 }
  },
  "message": "Locations retrieved successfully"
}
```

### POST /companions/:id/locations
**Request:**
```json
{
  "city": "string",
  "region": "string",
  "isPopular": true,
  "description": "string"
}
```
**Response:**
```json
{
  "success": true,
  "data": { "locationId": "string", "created": true },
  "message": "Location created successfully"
}
```

## [ADDED] Customer Endpoints

### GET /customers/all
**Query Parameters:**
```
search?: string
status?: string
sortBy?: string
sortOrder?: "asc" | "desc"
page?: number
limit?: number
```
**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "string",
      "email": "string",
      "phone": "string",
      "displayName": "string",
      "profileImage": "string",
      "status": "string",
      "loyaltyPoints": 0,
      "emailVerified": true,
      "phoneVerified": true,
      "preferredLanguage": "string",
      "createdAt": "string",
      "lastLoginAt": "string",
      "preferences": {}
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 100, "totalPages": 5 },
  "message": "Customers retrieved successfully"
}
```

### GET /customers/:id
**Response:**
```json
{
  "success": true,
  "data": {
    "id": "string",
    "displayName": "string",
    "profileImage": "string",
    "loyaltyPoints": 0,
    "preferences": {},
    "memberSince": "string",
    "statistics": {
      "totalBookings": 0,
      "completedBookings": 0,
      "pendingBookings": 0,
      "cancelledBookings": 0,
      "favoriteSuppliers": 0
    },
    "language": "string",
    "emailVerified": true,
    "phoneVerified": true
  },
  "message": "Customer profile retrieved successfully"
}
```

### GET /customers/:id/bookings
**Query Parameters:**
```
page?: number
limit?: number
```
**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "string",
      "status": "string",
      "scheduledAt": "string",
      "duration": 0,
      "totalAmount": 0,
      "currency": "string",
      "notes": "string",
      "createdAt": "string",
      "updatedAt": "string",
      "service": {
        "title": "string",
        "description": "string"
      },
      "supplier": {
        "name": "string",
        "profileImage": "string"
      }
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 100, "totalPages": 5 },
  "message": "Booking history retrieved successfully"
}
```

### POST /customers/:id/bookings
**Request:**
```json
{
  "serviceId": "string",
  "scheduledAt": "string",
  "duration": 60,
  "notes": "string?"
}
```
**Response:**
```json
{
  "success": true,
  "data": {
    "bookingId": "string",
    "status": "pending",
    "totalAmount": 0,
    "currency": "string"
  },
  "message": "Booking created successfully"
}
```

### GET /customers/:id/favorites
**Query Parameters:**
```
page?: number
limit?: number
```
**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "string",
      "displayName": "string",
      "bio": "string",
      "profileImages": ["string"],
      "categories": ["string"],
      "rating": { "average": 0, "count": 0 },
      "verificationStatus": "string"
    }
  ],
  "pagination": { "page": 1, "limit": 20, "total": 100, "totalPages": 5 },
  "message": "Favorite suppliers retrieved successfully"
}
```

### POST /customers/:id/favorites/:supplierId
**Response:**
```json
{
  "success": true,
  "data": {
    "added": true,
    "totalFavorites": 1
  },
  "message": "Supplier added to favorites"
}
```

### POST /customers/:id/reviews
**Request:**
```json
{
  "bookingId": "string",
  "rating": 5,
  "comment": "string?",
  "isPublic": true
}
```
**Response:**
```json
{
  "success": true,
  "data": {
    "reviewId": "string",
    "submitted": true
  },
  "message": "Review submitted successfully"
}
```