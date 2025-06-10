import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { 
  userRegistrationSchema,
  userLoginSchema,
  bookingCreateSchema,
  reviewCreateSchema,
  profileUpdateSchema,
  phoneVerificationSchema,
  passwordResetSchema,
  validateEmail,
  validatePhone,
  validatePassword,
  sanitizeHtml,
  validateFileUpload
} from '@/utils/validation';

describe('Validation Utils', () => {
  describe('Schema Validations', () => {
    describe('User Registration Schema', () => {
      it('should validate correct registration data', () => {
        const validData = {
          email: 'test@example.com',
          password: 'SecurePass123!',
          phone: '+66812345678',
          userType: 'customer',
          firstName: 'John',
          lastName: 'Doe'
        };

        const result = userRegistrationSchema.safeParse(validData);
        expect(result.success).toBe(true);
      });

      it('should reject invalid email', () => {
        const invalidData = {
          email: 'invalid-email',
          password: 'SecurePass123!',
          phone: '+66812345678',
          userType: 'customer'
        };

        const result = userRegistrationSchema.safeParse(invalidData);
        expect(result.success).toBe(false);
        expect(result.error?.issues[0].path).toContain('email');
      });

      it('should reject weak password', () => {
        const invalidData = {
          email: 'test@example.com',
          password: '123', // Too weak
          phone: '+66812345678',
          userType: 'customer'
        };

        const result = userRegistrationSchema.safeParse(invalidData);
        expect(result.success).toBe(false);
        expect(result.error?.issues[0].path).toContain('password');
      });

      it('should reject invalid phone format', () => {
        const invalidData = {
          email: 'test@example.com',
          password: 'SecurePass123!',
          phone: '123456', // Invalid format
          userType: 'customer'
        };

        const result = userRegistrationSchema.safeParse(invalidData);
        expect(result.success).toBe(false);
        expect(result.error?.issues[0].path).toContain('phone');
      });

      it('should reject invalid user type', () => {
        const invalidData = {
          email: 'test@example.com',
          password: 'SecurePass123!',
          phone: '+66812345678',
          userType: 'invalid-type'
        };

        const result = userRegistrationSchema.safeParse(invalidData);
        expect(result.success).toBe(false);
        expect(result.error?.issues[0].path).toContain('userType');
      });
    });

    describe('User Login Schema', () => {
      it('should validate email login', () => {
        const validData = {
          email: 'test@example.com',
          password: 'SecurePass123!'
        };

        const result = userLoginSchema.safeParse(validData);
        expect(result.success).toBe(true);
      });

      it('should validate phone login', () => {
        const validData = {
          phone: '+66812345678',
          password: 'SecurePass123!'
        };

        const result = userLoginSchema.safeParse(validData);
        expect(result.success).toBe(true);
      });

      it('should reject login without email or phone', () => {
        const invalidData = {
          password: 'SecurePass123!'
        };

        const result = userLoginSchema.safeParse(invalidData);
        expect(result.success).toBe(false);
      });

      it('should reject login without password', () => {
        const invalidData = {
          email: 'test@example.com'
        };

        const result = userLoginSchema.safeParse(invalidData);
        expect(result.success).toBe(false);
        expect(result.error?.issues[0].path).toContain('password');
      });
    });

    describe('Booking Create Schema', () => {
      it('should validate correct booking data', () => {
        const validData = {
          companionId: '123e4567-e89b-12d3-a456-426614174000',
          serviceId: '123e4567-e89b-12d3-a456-426614174001',
          startTime: new Date(Date.now() + 86400000).toISOString(), // Tomorrow
          endTime: new Date(Date.now() + 90000000).toISOString(), // Tomorrow + 1 hour
          location: 'Bangkok, Thailand',
          notes: 'Special requirements',
          paymentMethodId: 'pm_test123'
        };

        const result = bookingCreateSchema.safeParse(validData);
        expect(result.success).toBe(true);
      });

      it('should reject booking with past start time', () => {
        const invalidData = {
          companionId: '123e4567-e89b-12d3-a456-426614174000',
          startTime: new Date(Date.now() - 86400000).toISOString(), // Yesterday
          endTime: new Date(Date.now() + 3600000).toISOString(),
          location: 'Bangkok, Thailand'
        };

        const result = bookingCreateSchema.safeParse(invalidData);
        expect(result.success).toBe(false);
      });

      it('should reject booking with end time before start time', () => {
        const invalidData = {
          companionId: '123e4567-e89b-12d3-a456-426614174000',
          startTime: new Date(Date.now() + 86400000).toISOString(),
          endTime: new Date(Date.now() + 82800000).toISOString(), // Before start time
          location: 'Bangkok, Thailand'
        };

        const result = bookingCreateSchema.safeParse(invalidData);
        expect(result.success).toBe(false);
      });

      it('should reject invalid UUID for companionId', () => {
        const invalidData = {
          companionId: 'invalid-uuid',
          startTime: new Date(Date.now() + 86400000).toISOString(),
          endTime: new Date(Date.now() + 90000000).toISOString(),
          location: 'Bangkok, Thailand'
        };

        const result = bookingCreateSchema.safeParse(invalidData);
        expect(result.success).toBe(false);
        expect(result.error?.issues[0].path).toContain('companionId');
      });
    });

    describe('Review Create Schema', () => {
      it('should validate correct review data', () => {
        const validData = {
          bookingId: '123e4567-e89b-12d3-a456-426614174000',
          rating: 5,
          comment: 'Excellent service!',
          categories: {
            communication: 5,
            punctuality: 4,
            professionalism: 5
          }
        };

        const result = reviewCreateSchema.safeParse(validData);
        expect(result.success).toBe(true);
      });

      it('should reject invalid rating', () => {
        const invalidData = {
          bookingId: '123e4567-e89b-12d3-a456-426614174000',
          rating: 6, // Out of range (1-5)
          comment: 'Good service'
        };

        const result = reviewCreateSchema.safeParse(invalidData);
        expect(result.success).toBe(false);
        expect(result.error?.issues[0].path).toContain('rating');
      });

      it('should reject comment that is too long', () => {
        const invalidData = {
          bookingId: '123e4567-e89b-12d3-a456-426614174000',
          rating: 5,
          comment: 'A'.repeat(1001) // Too long (max 1000 chars)
        };

        const result = reviewCreateSchema.safeParse(invalidData);
        expect(result.success).toBe(false);
        expect(result.error?.issues[0].path).toContain('comment');
      });
    });

    describe('Profile Update Schema', () => {
      it('should validate correct profile data', () => {
        const validData = {
          firstName: 'John',
          lastName: 'Doe',
          bio: 'Professional companion with 5 years experience',
          location: 'Bangkok, Thailand',
          languages: ['English', 'Thai'],
          interests: ['Travel', 'Food', 'Culture']
        };

        const result = profileUpdateSchema.safeParse(validData);
        expect(result.success).toBe(true);
      });

      it('should allow partial updates', () => {
        const validData = {
          firstName: 'John'
        };

        const result = profileUpdateSchema.safeParse(validData);
        expect(result.success).toBe(true);
      });

      it('should reject bio that is too long', () => {
        const invalidData = {
          bio: 'A'.repeat(1001) // Too long
        };

        const result = profileUpdateSchema.safeParse(invalidData);
        expect(result.success).toBe(false);
        expect(result.error?.issues[0].path).toContain('bio');
      });
    });
  });

  describe('Individual Validators', () => {
    describe('Email Validation', () => {
      it('should validate correct emails', () => {
        const validEmails = [
          'test@example.com',
          'user.name@domain.co.uk',
          'user+tag@example.org',
          'firstname.lastname@company.com'
        ];

        validEmails.forEach(email => {
          expect(validateEmail(email)).toBe(true);
        });
      });

      it('should reject invalid emails', () => {
        const invalidEmails = [
          'invalid-email',
          '@example.com',
          'test@',
          'test..test@example.com',
          'test@example',
          ''
        ];

        invalidEmails.forEach(email => {
          expect(validateEmail(email)).toBe(false);
        });
      });
    });

    describe('Phone Validation', () => {
      it('should validate correct phone numbers', () => {
        const validPhones = [
          '+66812345678',
          '+1234567890',
          '+44123456789',
          '+81234567890'
        ];

        validPhones.forEach(phone => {
          expect(validatePhone(phone)).toBe(true);
        });
      });

      it('should reject invalid phone numbers', () => {
        const invalidPhones = [
          '123456789', // No country code
          '+123', // Too short
          '+123456789012345', // Too long
          'abc123456789', // Contains letters
          ''
        ];

        invalidPhones.forEach(phone => {
          expect(validatePhone(phone)).toBe(false);
        });
      });
    });

    describe('Password Validation', () => {
      it('should validate strong passwords', () => {
        const strongPasswords = [
          'SecurePass123!',
          'MyP@ssw0rd',
          'Complex123$',
          'Str0ng!Password'
        ];

        strongPasswords.forEach(password => {
          expect(validatePassword(password)).toBe(true);
        });
      });

      it('should reject weak passwords', () => {
        const weakPasswords = [
          '123456', // Too short, no complexity
          'password', // No numbers or symbols
          'PASSWORD', // No lowercase or numbers
          '12345678', // No letters
          'Pass123', // Too short
          ''
        ];

        weakPasswords.forEach(password => {
          expect(validatePassword(password)).toBe(false);
        });
      });
    });
  });

  describe('HTML Sanitization', () => {
    it('should remove dangerous HTML tags', () => {
      const dangerousHtml = '<script>alert("xss")</script><p>Safe content</p>';
      const sanitized = sanitizeHtml(dangerousHtml);
      
      expect(sanitized).not.toContain('<script>');
      expect(sanitized).not.toContain('</script>');
      expect(sanitized).toContain('Safe content');
    });

    it('should preserve safe HTML tags', () => {
      const safeHtml = '<p>This is <strong>bold</strong> and <em>italic</em> text.</p>';
      const sanitized = sanitizeHtml(safeHtml);
      
      expect(sanitized).toContain('<p>');
      expect(sanitized).toContain('<strong>');
      expect(sanitized).toContain('<em>');
    });

    it('should handle empty and null inputs', () => {
      expect(sanitizeHtml('')).toBe('');
      expect(sanitizeHtml(null as any)).toBe('');
      expect(sanitizeHtml(undefined as any)).toBe('');
    });
  });

  describe('File Upload Validation', () => {
    it('should validate correct image files', () => {
      const validFile = {
        name: 'profile.jpg',
        type: 'image/jpeg',
        size: 1024 * 1024 // 1MB
      };

      const result = validateFileUpload(validFile, {
        allowedTypes: ['image/jpeg', 'image/png'],
        maxSize: 5 * 1024 * 1024 // 5MB
      });

      expect(result.valid).toBe(true);
    });

    it('should reject files with invalid type', () => {
      const invalidFile = {
        name: 'document.pdf',
        type: 'application/pdf',
        size: 1024 * 1024
      };

      const result = validateFileUpload(invalidFile, {
        allowedTypes: ['image/jpeg', 'image/png'],
        maxSize: 5 * 1024 * 1024
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('type');
    });

    it('should reject files that are too large', () => {
      const largeFile = {
        name: 'large-image.jpg',
        type: 'image/jpeg',
        size: 10 * 1024 * 1024 // 10MB
      };

      const result = validateFileUpload(largeFile, {
        allowedTypes: ['image/jpeg', 'image/png'],
        maxSize: 5 * 1024 * 1024 // 5MB max
      });

      expect(result.valid).toBe(false);
      expect(result.error).toContain('size');
    });
  });
});
