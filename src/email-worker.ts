export interface Env {
  // Email templates stored in KV
  EMAIL_TEMPLATES: KVNamespace;
  // From email address
  FROM_EMAIL: string;
  FROM_NAME: string;
  // Resend API key
  RESEND_API_KEY: string;
}

interface EmailRequest {
  to: string;
  subject: string;
  template: string;
  data?: Record<string, any>;
}

interface ResendResponse {
  id: string;
  from: string;
  to: string[];
  created_at: string;
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
      
      // Send email using Resend API
      try {
        const emailResponse = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: `${env.FROM_NAME} <${env.FROM_EMAIL}>`,
            to: [to],
            subject: subject,
            html: htmlContent,
          }),
        });

        if (!emailResponse.ok) {
          const errorText = await emailResponse.text();
          console.error('Resend API error:', errorText);
          throw new Error(`Resend API error: ${emailResponse.status} ${errorText}`);
        }

        const result = await emailResponse.json() as ResendResponse;
        console.log('Email sent successfully via Resend:', result);
        
        return new Response(JSON.stringify({
          success: true,
          message: `Email sent successfully to ${to}`,
          emailId: result.id
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (emailError) {
        console.error('Failed to send email via Resend:', emailError);
        
        // Fallback to logging for development
        console.log('=== EMAIL TO SEND (FALLBACK) ===');
        console.log('To:', to);
        console.log('Subject:', subject);
        console.log('Template:', template);
        console.log('Data:', data);
        console.log('HTML Content:', htmlContent);
        console.log('================================');
        
        return new Response(JSON.stringify({
          success: false,
          message: `Failed to send email to ${to}`,
          error: emailError instanceof Error ? emailError.message : 'Unknown error',
          warning: 'Email logged to console as fallback'
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
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
