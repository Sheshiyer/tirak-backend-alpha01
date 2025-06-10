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
  "phone": "string?",
  "dateOfBirth": "string?",
  "gender": "string?",
  "profileImage": "string?",
  "preferences": {
    "language": "string?",
    "currency": "string?",
    "notifications": {
      "push": boolean?,
      "email": boolean?,
      "sms": boolean?
    }?
  }?
}
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "user": "UserProfile"
  },
  "message": "string"
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
  "success": boolean,
  "data": {
    "availability": [
      {
        "date": "string",
        "available": boolean,
        "timeSlots": [
          {
            "start": "string",
            "end": "string",
            "available": boolean,
            "price": number?
          }
        ]
      }
    ]
  }
}
```

## Supplier Management Endpoints

### POST /suppliers/signup
**Request:**
```json
{
  "basicInfo": {
    "firstName": "string",
    "lastName": "string",
    "displayName": "string",
    "phone": "string",
    "email": "string",
    "bio": "string",
    "dateOfBirth": "string",
    "gender": "string"
  },
  "idVerification": {
    "idCardFront": "string",
    "idCardBack": "string",
    "selfieWithId": "string",
    "idNumber": "string"
  },
  "photos": ["string"],
  "categories": ["string"],
  "services": [
    {
      "name": "string",
      "description": "string",
      "price": number,
      "duration": "string",
      "category": "string"
    }
  ],
  "regions": ["string"],
  "availability": {
    "weeklySchedule": {
      "monday": [{"start": "string", "end": "string"}],
      "tuesday": [{"start": "string", "end": "string"}],
      "wednesday": [{"start": "string", "end": "string"}],
      "thursday": [{"start": "string", "end": "string"}],
      "friday": [{"start": "string", "end": "string"}],
      "saturday": [{"start": "string", "end": "string"}],
      "sunday": [{"start": "string", "end": "string"}]
    }
  },
  "subscription": {
    "plan": "basic" | "premium" | "pro",
    "paymentMethod": "promptpay" | "card" | "bank_transfer"
  }
}
```

**Response:**
```json
{
  "success": boolean,
  "data": {
    "supplierId": "string",
    "status": "pending_review" | "approved" | "rejected",
    "estimatedReviewTime": "string"
  },
  "message": "string"
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