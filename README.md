# Tirak Backend

A comprehensive backend API for Tirak's guided-experience marketplace, built with Cloudflare Workers and modern web technologies. Legacy `companion` identifiers remain internal compatibility aliases while public contracts use local-guide and named-experience language.

## 🚀 Features

- **Authentication & Authorization**: JWT-based auth with role-based access control
- **Real-time Chat**: WebSocket-powered chat using Durable Objects
- **File Storage**: Secure file uploads with R2 storage
- **Search & Discovery**: Advanced supplier search with filtering
- **Analytics**: Event tracking and business intelligence
- **Moderation**: Automated content moderation with manual review
- **Multi-language**: Support for English and Thai
- **Global Scale**: Deployed on Cloudflare's global network

## 🛠 Tech Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono.js
- **Database**: Cloudflare D1 (SQLite)
- **Storage**: Cloudflare R2
- **Cache**: Cloudflare KV
- **Real-time**: Durable Objects
- **Queue**: Cloudflare Queues
- **Language**: TypeScript
- **Validation**: Zod
- **Testing**: Vitest

## 📁 Project Structure

```
tirak-backend/
├── src/
│   ├── index.ts                    # Main worker entry point
│   ├── types/                      # TypeScript type definitions
│   ├── utils/                      # Utility functions
│   ├── middleware/                 # Request middleware
│   ├── routes/                     # API route handlers
│   ├── durable-objects/            # Real-time services
│   └── background/                 # Background job processors
├── migrations/                     # Database migrations
├── scripts/                        # Deployment and utility scripts
├── wrangler.toml                   # Cloudflare configuration
└── package.json                    # Dependencies and scripts
```

## 🚦 Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn
- Cloudflare account with Workers enabled
- Wrangler CLI installed globally

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd tirak-backend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up Cloudflare resources**
   ```bash
   # Login to Cloudflare
   wrangler login
   
   # Create D1 database
   wrangler d1 create tirak-development
   
   # Create R2 bucket
   wrangler r2 bucket create tirak-storage-dev
   
   # Create KV namespaces
   wrangler kv:namespace create "CACHE"
   wrangler kv:namespace create "SESSIONS"
   ```

4. **Update wrangler.toml**
   - Replace placeholder IDs with actual resource IDs from step 3

5. **Run database migrations**
   ```bash
   npm run db:migrate
   ```

6. **Start development server**
   ```bash
   npm run dev
   ```

## 🗄 Database Setup

The project uses Cloudflare D1 (SQLite) with migrations for schema management.

### Running Migrations

```bash
# Development
npm run db:migrate

# Staging
npm run db:migrate:staging

# Production
npm run db:migrate:production
```

### Seeding Data

```bash
npm run db:seed
```

## 🚀 Deployment

### Staging Deployment

```bash
npm run deploy:staging
```

### Production Deployment

```bash
npm run deploy:production
```

## 📊 Monitoring

### View Logs

```bash
# Development
npm run logs

# Staging
npm run logs:staging

# Production
npm run logs:production
```

## 🧪 Testing

```bash
# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Type checking
npm run typecheck
```

## 🔧 Configuration

### Environment Variables

Set these via `wrangler secret put`:

```bash
wrangler secret put JWT_SECRET
wrangler secret put SMS_API_KEY
wrangler secret put OPENAI_API_KEY
```

### Wrangler Configuration

The `wrangler.toml` file contains environment-specific configurations:

- **Development**: Local development with dev resources
- **Staging**: Pre-production testing environment  
- **Production**: Live production environment

## 📚 API Documentation

### Authentication Endpoints

- `POST /api/auth/register` - User registration
- `POST /api/auth/login` - User login
- `POST /api/auth/verify-phone` - Phone verification
- `POST /api/auth/refresh` - Token refresh

### User Management

- `GET /api/users/profile` - Get user profile
- `PUT /api/users/profile` - Update user profile
- `POST /api/users/upload-avatar` - Upload profile image

### Supplier Discovery

- `GET /api/suppliers/search` - Search suppliers
- `GET /api/suppliers/:id` - Get supplier details

### Chat System

- `GET /api/chat/rooms` - Get chat rooms
- `POST /api/chat/rooms` - Create chat room
- `WebSocket /api/chat/ws` - Real-time messaging

## 🔒 Security

- JWT-based authentication
- Role-based authorization
- Rate limiting
- Input validation with Zod
- CORS protection
- Content Security Policy
- Automated content moderation

## 🌍 Internationalization

The platform supports multiple languages:

- English (en)
- Thai (th)

Language detection is based on user preferences and Accept-Language headers.

## 📈 Analytics

The platform tracks various events for business intelligence:

- User registration and login
- Supplier searches and views
- Chat interactions
- Booking activities
- Performance metrics

## 🛡 Content Moderation

Automated moderation includes:

- Text analysis for inappropriate content
- Image analysis for explicit content
- Spam detection
- Manual review workflow

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🆘 Support

For support and questions:

- Create an issue in the repository
- Contact the development team
- Check the documentation

## 🗺 Roadmap

- [ ] Payment processing integration
- [ ] Advanced analytics dashboard
- [ ] Mobile push notifications
- [ ] Machine learning recommendations
- [ ] Multi-region deployment
- [ ] Advanced search with Elasticsearch
