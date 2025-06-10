import type { Env } from '../index';

export interface ModerationJob {
  type: 'text_analysis' | 'image_analysis' | 'profile_review' | 'manual_review';
  contentId: string;
  userId: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  metadata: {
    roomId?: string;
    content?: string;
    imageUrl?: string;
    profileData?: any;
    reportId?: string;
  };
  timestamp: string;
}

export interface ModerationResult {
  contentId: string;
  action: 'approve' | 'flag' | 'remove' | 'escalate' | 'suspend_user';
  confidence: number; // 0-1
  reasons: string[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  aiAnalysis?: {
    toxicity: number;
    sentiment: 'positive' | 'neutral' | 'negative';
    inappropriateContent: boolean;
    languageViolations: string[];
    riskScore: number;
  };
}

/**
 * Main queue consumer for moderation jobs
 */
export async function handleModerationQueue(batch: MessageBatch<ModerationJob>, env: Env): Promise<void> {
  console.log(`Processing ${batch.messages.length} moderation jobs`);

  for (const message of batch.messages) {
    try {
      const job = message.body;
      console.log(`Processing moderation job: ${job.type} for content ${job.contentId}`);

      let result: ModerationResult;

      switch (job.type) {
        case 'text_analysis':
          result = await processTextAnalysis(job, env);
          break;
        case 'image_analysis':
          result = await processImageAnalysis(job, env);
          break;
        case 'profile_review':
          result = await processProfileReview(job, env);
          break;
        case 'manual_review':
          result = await processManualReview(job, env);
          break;
        default:
          console.error(`Unknown moderation job type: ${job.type}`);
          message.ack();
          continue;
      }

      // Execute moderation action
      await executeModerationAction(result, job, env);

      // Store moderation result
      await storeModerationResult(result, job, env);

      // Send notifications if needed
      await sendModerationNotifications(result, job, env);

      message.ack();
      console.log(`Completed moderation job: ${job.contentId}`);

    } catch (error) {
      console.error(`Failed to process moderation job:`, error);
      message.retry();
    }
  }
}

/**
 * Process text content analysis
 */
async function processTextAnalysis(job: ModerationJob, env: Env): Promise<ModerationResult> {
  const { content } = job.metadata;
  
  if (!content) {
    throw new Error('No content provided for text analysis');
  }

  // AI-based content analysis (placeholder for actual AI service integration)
  const aiAnalysis = await analyzeTextContent(content, env);
  
  // Determine action based on analysis
  let action: ModerationResult['action'] = 'approve';
  let severity: ModerationResult['severity'] = 'low';
  const reasons: string[] = [];

  if (aiAnalysis.toxicity > 0.8) {
    action = 'remove';
    severity = 'high';
    reasons.push('High toxicity detected');
  } else if (aiAnalysis.toxicity > 0.6) {
    action = 'flag';
    severity = 'medium';
    reasons.push('Moderate toxicity detected');
  }

  if (aiAnalysis.inappropriateContent) {
    action = action === 'approve' ? 'flag' : action;
    severity = severity === 'low' ? 'medium' : severity;
    reasons.push('Inappropriate content detected');
  }

  if (aiAnalysis.languageViolations.length > 0) {
    action = action === 'approve' ? 'flag' : action;
    reasons.push(`Language violations: ${aiAnalysis.languageViolations.join(', ')}`);
  }

  // Check for repeat offender
  const userViolations = await getUserViolationCount(job.userId, env);
  if (userViolations >= 3 && action !== 'approve') {
    action = 'suspend_user';
    severity = 'critical';
    reasons.push('Repeat offender - multiple violations');
  }

  return {
    contentId: job.contentId,
    action,
    confidence: aiAnalysis.riskScore,
    reasons,
    severity,
    aiAnalysis
  };
}

/**
 * Process image content analysis
 */
async function processImageAnalysis(job: ModerationJob, env: Env): Promise<ModerationResult> {
  const { imageUrl } = job.metadata;
  
  if (!imageUrl) {
    throw new Error('No image URL provided for image analysis');
  }

  // AI-based image analysis (placeholder for actual AI service integration)
  const aiAnalysis = await analyzeImageContent(imageUrl, env);
  
  let action: ModerationResult['action'] = 'approve';
  let severity: ModerationResult['severity'] = 'low';
  const reasons: string[] = [];

  if (aiAnalysis.inappropriateContent) {
    action = 'remove';
    severity = 'high';
    reasons.push('Inappropriate visual content detected');
  }

  if (aiAnalysis.riskScore > 0.7) {
    action = action === 'approve' ? 'flag' : action;
    severity = severity === 'low' ? 'medium' : severity;
    reasons.push('High risk visual content');
  }

  return {
    contentId: job.contentId,
    action,
    confidence: aiAnalysis.riskScore,
    reasons,
    severity,
    aiAnalysis
  };
}

/**
 * Process profile review
 */
async function processProfileReview(job: ModerationJob, env: Env): Promise<ModerationResult> {
  const { profileData } = job.metadata;
  
  if (!profileData) {
    throw new Error('No profile data provided for review');
  }

  // Analyze profile completeness and authenticity
  const profileAnalysis = await analyzeProfile(profileData, env);
  
  let action: ModerationResult['action'] = 'approve';
  let severity: ModerationResult['severity'] = 'low';
  const reasons: string[] = [];

  if (profileAnalysis.suspiciousActivity) {
    action = 'escalate';
    severity = 'medium';
    reasons.push('Suspicious profile activity detected');
  }

  if (profileAnalysis.incompleteVerification) {
    action = 'flag';
    reasons.push('Incomplete verification documents');
  }

  return {
    contentId: job.contentId,
    action,
    confidence: profileAnalysis.trustScore,
    reasons,
    severity
  };
}

/**
 * Process manual review escalation
 */
async function processManualReview(job: ModerationJob, env: Env): Promise<ModerationResult> {
  // For manual review, we just flag for human moderator attention
  return {
    contentId: job.contentId,
    action: 'escalate',
    confidence: 1.0,
    reasons: ['Escalated for manual review'],
    severity: 'medium'
  };
}

/**
 * Execute the determined moderation action
 */
async function executeModerationAction(result: ModerationResult, job: ModerationJob, env: Env): Promise<void> {
  switch (result.action) {
    case 'remove':
      await removeContent(job.contentId, job.type, env);
      break;
    case 'flag':
      await flagContent(job.contentId, result.reasons, env);
      break;
    case 'suspend_user':
      await suspendUser(job.userId, result.severity, result.reasons, env);
      break;
    case 'escalate':
      await escalateToHuman(job, result, env);
      break;
    case 'approve':
      // No action needed for approved content
      break;
  }
}

/**
 * Store moderation result in database
 */
async function storeModerationResult(result: ModerationResult, job: ModerationJob, env: Env): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO moderation_results (
      id, content_id, user_id, job_type, action, confidence, 
      reasons, severity, ai_analysis, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    result.contentId,
    job.userId,
    job.type,
    result.action,
    result.confidence,
    JSON.stringify(result.reasons),
    result.severity,
    JSON.stringify(result.aiAnalysis || {}),
    new Date().toISOString()
  ).run();
}

/**
 * Send notifications about moderation actions
 */
async function sendModerationNotifications(result: ModerationResult, job: ModerationJob, env: Env): Promise<void> {
  // Notify admins for high severity actions
  if (result.severity === 'high' || result.severity === 'critical') {
    await env.NOTIFICATION_SERVICE.get(env.NOTIFICATION_SERVICE.idFromName('admin')).fetch('http://localhost/send-notification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'moderation_alert',
        title: 'High Severity Moderation Action',
        message: `${result.action} executed for ${job.type}: ${result.reasons.join(', ')}`,
        data: {
          contentId: result.contentId,
          userId: job.userId,
          action: result.action,
          severity: result.severity
        }
      })
    });
  }

  // Notify user if suspended
  if (result.action === 'suspend_user') {
    // Send user notification about suspension
    await env.NOTIFICATION_SERVICE.get(env.NOTIFICATION_SERVICE.idFromName(job.userId)).fetch('http://localhost/send-notification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'account_suspended',
        title: 'Account Suspended',
        message: 'Your account has been temporarily suspended due to policy violations.',
        data: {
          reasons: result.reasons,
          severity: result.severity
        }
      })
    });
  }
}

// Helper functions for AI analysis (placeholders for actual AI service integration)

async function analyzeTextContent(content: string, env: Env): Promise<NonNullable<ModerationResult['aiAnalysis']>> {
  // Placeholder for actual AI service integration (OpenAI, Google Cloud AI, etc.)
  // This would integrate with services like OpenAI Moderation API, Google Cloud Natural Language API, etc.
  
  const toxicity = calculateToxicity(content);
  const sentiment = analyzeSentiment(content);
  const inappropriateContent = detectInappropriateContent(content);
  const languageViolations = detectLanguageViolations(content);
  const riskScore = Math.max(toxicity, inappropriateContent ? 0.8 : 0);

  return {
    toxicity,
    sentiment,
    inappropriateContent,
    languageViolations,
    riskScore
  };
}

async function analyzeImageContent(imageUrl: string, env: Env): Promise<NonNullable<ModerationResult['aiAnalysis']>> {
  // Placeholder for actual image analysis service (Google Vision API, AWS Rekognition, etc.)
  
  return {
    toxicity: 0,
    sentiment: 'neutral',
    inappropriateContent: false,
    languageViolations: [],
    riskScore: 0.1
  };
}

async function analyzeProfile(profileData: any, env: Env): Promise<{ suspiciousActivity: boolean; incompleteVerification: boolean; trustScore: number }> {
  // Placeholder for profile analysis logic
  
  return {
    suspiciousActivity: false,
    incompleteVerification: !profileData.emailVerified || !profileData.phoneVerified,
    trustScore: 0.8
  };
}

// Helper functions for content analysis

function calculateToxicity(content: string): number {
  // Simple keyword-based toxicity detection (replace with actual AI service)
  const toxicKeywords = ['hate', 'violence', 'abuse', 'threat'];
  const words = content.toLowerCase().split(/\s+/);
  const toxicCount = words.filter(word => toxicKeywords.some(keyword => word.includes(keyword))).length;
  return Math.min(toxicCount / words.length * 10, 1);
}

function analyzeSentiment(content: string): 'positive' | 'neutral' | 'negative' {
  // Simple sentiment analysis (replace with actual AI service)
  const positiveWords = ['good', 'great', 'excellent', 'amazing', 'wonderful'];
  const negativeWords = ['bad', 'terrible', 'awful', 'horrible', 'disgusting'];
  
  const words = content.toLowerCase().split(/\s+/);
  const positiveCount = words.filter(word => positiveWords.includes(word)).length;
  const negativeCount = words.filter(word => negativeWords.includes(word)).length;
  
  if (positiveCount > negativeCount) return 'positive';
  if (negativeCount > positiveCount) return 'negative';
  return 'neutral';
}

function detectInappropriateContent(content: string): boolean {
  // Simple inappropriate content detection (replace with actual AI service)
  const inappropriateKeywords = ['explicit', 'sexual', 'drug', 'illegal'];
  return inappropriateKeywords.some(keyword => content.toLowerCase().includes(keyword));
}

function detectLanguageViolations(content: string): string[] {
  // Simple language violation detection (replace with actual AI service)
  const violations: string[] = [];
  const profanityWords = ['damn', 'hell']; // Add actual profanity list
  
  profanityWords.forEach(word => {
    if (content.toLowerCase().includes(word)) {
      violations.push(`Profanity: ${word}`);
    }
  });
  
  return violations;
}

// Helper functions for moderation actions

async function removeContent(contentId: string, contentType: string, env: Env): Promise<void> {
  if (contentType === 'text_analysis') {
    await env.DB.prepare(`
      UPDATE chat_messages SET is_deleted = TRUE, deleted_reason = 'moderation' 
      WHERE id = ?
    `).bind(contentId).run();
  }
}

async function flagContent(contentId: string, reasons: string[], env: Env): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO flagged_content (id, content_id, reasons, flagged_at)
    VALUES (?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    contentId,
    JSON.stringify(reasons),
    new Date().toISOString()
  ).run();
}

async function suspendUser(userId: string, severity: string, reasons: string[], env: Env): Promise<void> {
  const suspensionDays = severity === 'critical' ? 30 : severity === 'high' ? 7 : 3;
  const suspensionEnd = new Date();
  suspensionEnd.setDate(suspensionEnd.getDate() + suspensionDays);

  await env.DB.prepare(`
    UPDATE users SET 
      status = 'suspended',
      suspension_end = ?,
      suspension_reason = ?
    WHERE id = ?
  `).bind(
    suspensionEnd.toISOString(),
    JSON.stringify(reasons),
    userId
  ).run();
}

async function escalateToHuman(job: ModerationJob, result: ModerationResult, env: Env): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO manual_review_queue (
      id, content_id, user_id, job_type, ai_result, 
      priority, created_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    crypto.randomUUID(),
    job.contentId,
    job.userId,
    job.type,
    JSON.stringify(result),
    job.priority,
    new Date().toISOString(),
    'pending'
  ).run();
}

async function getUserViolationCount(userId: string, env: Env): Promise<number> {
  const result = await env.DB.prepare(`
    SELECT COUNT(*) as count 
    FROM moderation_results 
    WHERE user_id = ? AND action IN ('remove', 'flag', 'suspend_user')
    AND created_at > datetime('now', '-30 days')
  `).bind(userId).first();
  
  return result?.count || 0;
}
