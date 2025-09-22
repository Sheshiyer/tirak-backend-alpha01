export interface Env {
  // Email templates stored in KV
  EMAIL_TEMPLATES: KVNamespace;
  // From email address
  FROM_EMAIL: string;
  FROM_NAME: string;
}

interface EmailRequest {
  to: string;
  subject: string;
  template: string;
  data?: Record<string, any>;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 200,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      }

      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }

      const { to, subject, template, data } = await request.json() as EmailRequest;
      
      if (!to || !subject || !template) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing required fields: to, subject, template'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Get email template from KV
      const templateData = await env.EMAIL_TEMPLATES.get(template);
      if (!templateData) {
        return new Response(JSON.stringify({
          success: false,
          error: `Template '${template}' not found`
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // Process template with data
      const htmlContent = processTemplate(templateData, data || {});
      
      // For now, we'll use a simple email service or log the email
      // In production, you would integrate with a real email service
      console.log('=== EMAIL TO SEND ===');
      console.log('To:', to);
      console.log('Subject:', subject);
      console.log('Template:', template);
      console.log('Data:', data);
      console.log('HTML Content:', htmlContent);
      console.log('====================');
      
      // Simulate email sending
      // In production, replace this with actual email sending logic
      await new Promise(resolve => setTimeout(resolve, 100));
      
      return new Response(JSON.stringify({
        success: true,
        message: `Email sent successfully to ${to} with template ${template}`
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
      
    } catch (error) {
      console.error('Email worker error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};

function processTemplate(template: string, data: Record<string, any>): string {
  let processedTemplate = template;
  
  // Replace placeholders with actual data
  Object.keys(data).forEach(key => {
    const placeholder = `{{${key}}}`;
    const value = data[key] || '';
    processedTemplate = processedTemplate.replace(new RegExp(placeholder, 'g'), value);
  });
  
  return processedTemplate;
}
