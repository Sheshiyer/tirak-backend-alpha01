import { describe, it, expect, beforeEach } from 'vitest';
import { 
  executeQuery, 
  executeTransaction, 
  buildWhereClause, 
  buildPaginationQuery,
  sanitizeInput,
  validateUUID,
  formatDatabaseError
} from '@/utils/database';
import { createTestEnv, createTestUser } from '@tests/setup';

describe('Database Utils', () => {
  let testEnv: any;

  beforeEach(() => {
    testEnv = createTestEnv();
  });

  describe('Query Execution', () => {
    it('should execute simple query successfully', async () => {
      const query = 'SELECT * FROM users WHERE id = ?';
      const params = ['test-user-id'];
      
      const result = await executeQuery(testEnv.DB, query, params);
      
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    it('should handle query with no parameters', async () => {
      const query = 'SELECT COUNT(*) as count FROM users';
      
      const result = await executeQuery(testEnv.DB, query);
      
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    it('should handle query errors gracefully', async () => {
      const invalidQuery = 'INVALID SQL SYNTAX';
      
      // Mock DB to throw error
      const mockDB = {
        prepare: () => {
          throw new Error('SQL syntax error');
        }
      };
      
      await expect(executeQuery(mockDB as any, invalidQuery)).rejects.toThrow();
    });

    it('should execute multiple queries in transaction', async () => {
      const queries = [
        { query: 'INSERT INTO users (id, email) VALUES (?, ?)', params: ['1', 'test1@example.com'] },
        { query: 'INSERT INTO users (id, email) VALUES (?, ?)', params: ['2', 'test2@example.com'] },
      ];
      
      const result = await executeTransaction(testEnv.DB, queries);
      
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
    });

    it('should rollback transaction on error', async () => {
      const queries = [
        { query: 'INSERT INTO users (id, email) VALUES (?, ?)', params: ['1', 'test1@example.com'] },
        { query: 'INVALID SQL', params: [] }, // This should cause rollback
      ];
      
      await expect(executeTransaction(testEnv.DB, queries)).rejects.toThrow();
    });
  });

  describe('Where Clause Builder', () => {
    it('should build simple where clause', () => {
      const conditions = { id: 'test-id', email: 'test@example.com' };
      const result = buildWhereClause(conditions);
      
      expect(result.clause).toBe('WHERE id = ? AND email = ?');
      expect(result.params).toEqual(['test-id', 'test@example.com']);
    });

    it('should handle empty conditions', () => {
      const conditions = {};
      const result = buildWhereClause(conditions);
      
      expect(result.clause).toBe('');
      expect(result.params).toEqual([]);
    });

    it('should handle null values', () => {
      const conditions = { id: 'test-id', deleted_at: null };
      const result = buildWhereClause(conditions);
      
      expect(result.clause).toBe('WHERE id = ? AND deleted_at IS NULL');
      expect(result.params).toEqual(['test-id']);
    });

    it('should handle array values (IN clause)', () => {
      const conditions = { status: ['active', 'pending', 'completed'] };
      const result = buildWhereClause(conditions);
      
      expect(result.clause).toBe('WHERE status IN (?, ?, ?)');
      expect(result.params).toEqual(['active', 'pending', 'completed']);
    });

    it('should handle mixed conditions', () => {
      const conditions = { 
        user_type: 'customer', 
        status: ['active', 'pending'], 
        deleted_at: null 
      };
      const result = buildWhereClause(conditions);
      
      expect(result.clause).toContain('WHERE');
      expect(result.clause).toContain('user_type = ?');
      expect(result.clause).toContain('status IN (?, ?)');
      expect(result.clause).toContain('deleted_at IS NULL');
      expect(result.params).toEqual(['customer', 'active', 'pending']);
    });
  });

  describe('Pagination Query Builder', () => {
    it('should build pagination query with default values', () => {
      const baseQuery = 'SELECT * FROM users';
      const result = buildPaginationQuery(baseQuery);
      
      expect(result.query).toContain('LIMIT');
      expect(result.query).toContain('OFFSET');
      expect(result.params).toEqual([20, 0]); // Default limit 20, offset 0
    });

    it('should build pagination query with custom values', () => {
      const baseQuery = 'SELECT * FROM users';
      const pagination = { page: 3, limit: 10 };
      const result = buildPaginationQuery(baseQuery, pagination);
      
      expect(result.query).toBe('SELECT * FROM users LIMIT ? OFFSET ?');
      expect(result.params).toEqual([10, 20]); // Page 3 with limit 10 = offset 20
    });

    it('should handle page 1 correctly', () => {
      const baseQuery = 'SELECT * FROM users';
      const pagination = { page: 1, limit: 15 };
      const result = buildPaginationQuery(baseQuery, pagination);
      
      expect(result.params).toEqual([15, 0]); // Page 1 = offset 0
    });

    it('should handle maximum limits', () => {
      const baseQuery = 'SELECT * FROM users';
      const pagination = { page: 1, limit: 1000 }; // Very high limit
      const result = buildPaginationQuery(baseQuery, pagination);
      
      // Should cap at maximum allowed limit (e.g., 100)
      expect(result.params[0]).toBeLessThanOrEqual(100);
    });

    it('should handle invalid pagination values', () => {
      const baseQuery = 'SELECT * FROM users';
      const pagination = { page: -1, limit: -5 };
      const result = buildPaginationQuery(baseQuery, pagination);
      
      // Should use defaults for invalid values
      expect(result.params[0]).toBeGreaterThan(0); // Positive limit
      expect(result.params[1]).toBeGreaterThanOrEqual(0); // Non-negative offset
    });
  });

  describe('Input Sanitization', () => {
    it('should sanitize string input', () => {
      const input = '  Test String  ';
      const result = sanitizeInput(input);
      
      expect(result).toBe('Test String');
    });

    it('should handle SQL injection attempts', () => {
      const maliciousInput = "'; DROP TABLE users; --";
      const result = sanitizeInput(maliciousInput);
      
      // Should escape or remove dangerous characters
      expect(result).not.toContain('DROP TABLE');
      expect(result).not.toContain('--');
    });

    it('should handle XSS attempts', () => {
      const xssInput = '<script>alert("xss")</script>';
      const result = sanitizeInput(xssInput);
      
      // Should escape HTML tags
      expect(result).not.toContain('<script>');
      expect(result).not.toContain('</script>');
    });

    it('should preserve valid content', () => {
      const validInput = 'Hello, World! This is a valid message.';
      const result = sanitizeInput(validInput);
      
      expect(result).toBe(validInput);
    });

    it('should handle empty and null inputs', () => {
      expect(sanitizeInput('')).toBe('');
      expect(sanitizeInput(null)).toBe('');
      expect(sanitizeInput(undefined)).toBe('');
    });

    it('should handle numbers and booleans', () => {
      expect(sanitizeInput(123)).toBe('123');
      expect(sanitizeInput(true)).toBe('true');
      expect(sanitizeInput(false)).toBe('false');
    });
  });

  describe('UUID Validation', () => {
    it('should validate correct UUID v4', () => {
      const validUUID = '123e4567-e89b-12d3-a456-426614174000';
      const result = validateUUID(validUUID);
      
      expect(result).toBe(true);
    });

    it('should reject invalid UUID formats', () => {
      const invalidUUIDs = [
        'not-a-uuid',
        '123e4567-e89b-12d3-a456', // Too short
        '123e4567-e89b-12d3-a456-426614174000-extra', // Too long
        '123e4567_e89b_12d3_a456_426614174000', // Wrong separators
        '', // Empty
        null, // Null
        undefined, // Undefined
      ];
      
      invalidUUIDs.forEach(uuid => {
        expect(validateUUID(uuid as any)).toBe(false);
      });
    });

    it('should handle case insensitivity', () => {
      const upperUUID = '123E4567-E89B-12D3-A456-426614174000';
      const lowerUUID = '123e4567-e89b-12d3-a456-426614174000';
      
      expect(validateUUID(upperUUID)).toBe(true);
      expect(validateUUID(lowerUUID)).toBe(true);
    });
  });

  describe('Error Formatting', () => {
    it('should format database constraint errors', () => {
      const constraintError = new Error('UNIQUE constraint failed: users.email');
      const formatted = formatDatabaseError(constraintError);
      
      expect(formatted.type).toBe('constraint_violation');
      expect(formatted.message).toContain('email');
      expect(formatted.field).toBe('email');
    });

    it('should format foreign key errors', () => {
      const fkError = new Error('FOREIGN KEY constraint failed');
      const formatted = formatDatabaseError(fkError);
      
      expect(formatted.type).toBe('foreign_key_violation');
      expect(formatted.message).toContain('foreign key');
    });

    it('should format syntax errors', () => {
      const syntaxError = new Error('SQL syntax error near "INVALID"');
      const formatted = formatDatabaseError(syntaxError);
      
      expect(formatted.type).toBe('syntax_error');
      expect(formatted.message).toContain('syntax');
    });

    it('should handle generic database errors', () => {
      const genericError = new Error('Database connection failed');
      const formatted = formatDatabaseError(genericError);
      
      expect(formatted.type).toBe('database_error');
      expect(formatted.message).toBeDefined();
    });

    it('should handle non-Error objects', () => {
      const stringError = 'Something went wrong';
      const formatted = formatDatabaseError(stringError as any);
      
      expect(formatted.type).toBe('unknown_error');
      expect(formatted.message).toBe(stringError);
    });
  });

  describe('Complex Query Scenarios', () => {
    it('should handle complex where clauses with operators', () => {
      const conditions = {
        'created_at >': '2023-01-01',
        'rating >=': 4,
        'status !=': 'deleted',
      };
      
      const result = buildWhereClause(conditions);
      
      expect(result.clause).toContain('created_at >');
      expect(result.clause).toContain('rating >=');
      expect(result.clause).toContain('status !=');
      expect(result.params).toEqual(['2023-01-01', 4, 'deleted']);
    });

    it('should build search queries with LIKE', () => {
      const conditions = {
        'name LIKE': '%john%',
        'email LIKE': '%@example.com',
      };
      
      const result = buildWhereClause(conditions);
      
      expect(result.clause).toContain('name LIKE');
      expect(result.clause).toContain('email LIKE');
      expect(result.params).toEqual(['%john%', '%@example.com']);
    });
  });
});
