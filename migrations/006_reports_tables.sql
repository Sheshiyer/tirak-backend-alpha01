-- Migration: Add reports tables
-- Description: Creates tables for the reports system

-- Create reports table
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('PDF', 'Excel', 'CSV', 'JSON')),
  size TEXT,
  url TEXT,
  template_id TEXT NOT NULL,
  parameters TEXT, -- JSON object of parameters used to generate the report
  generated_by TEXT NOT NULL,
  last_downloaded_at TEXT,
  download_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (template_id) REFERENCES report_templates(id) ON DELETE CASCADE
);

-- Create report_templates table
CREATE TABLE IF NOT EXISTS report_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  icon TEXT NOT NULL,
  parameters TEXT, -- JSON array of parameter objects
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Create scheduled_reports table
CREATE TABLE IF NOT EXISTS scheduled_reports (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  name TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  parameters TEXT NOT NULL, -- JSON object of parameters
  recipients TEXT, -- JSON array of recipient emails
  next_run TEXT NOT NULL,
  last_run TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (template_id) REFERENCES report_templates(id) ON DELETE CASCADE
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_reports_template_id ON reports(template_id);
CREATE INDEX IF NOT EXISTS idx_reports_category ON reports(category);
CREATE INDEX IF NOT EXISTS idx_reports_format ON reports(format);
CREATE INDEX IF NOT EXISTS idx_reports_generated_by ON reports(generated_by);
CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at);

CREATE INDEX IF NOT EXISTS idx_report_templates_category ON report_templates(category);
CREATE INDEX IF NOT EXISTS idx_report_templates_created_at ON report_templates(created_at);

CREATE INDEX IF NOT EXISTS idx_scheduled_reports_template_id ON scheduled_reports(template_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_reports_frequency ON scheduled_reports(frequency);
CREATE INDEX IF NOT EXISTS idx_scheduled_reports_next_run ON scheduled_reports(next_run);
CREATE INDEX IF NOT EXISTS idx_scheduled_reports_created_by ON scheduled_reports(created_by);

-- Insert default report templates
INSERT INTO report_templates (
  id, name, description, category, icon, parameters, created_at, updated_at
) VALUES 
(
  'template-financial-001',
  'Financial Performance Report',
  'Comprehensive analysis of revenue, expenses, and profit metrics',
  'financial',
  'money',
  '[
    {"name": "startDate", "type": "date", "label": "Start Date", "required": true},
    {"name": "endDate", "type": "date", "label": "End Date", "required": true},
    {"name": "includeCharts", "type": "boolean", "label": "Include Charts", "required": false, "default": true},
    {"name": "format", "type": "select", "label": "Format", "required": true, "default": "PDF", "options": [{"label": "PDF", "value": "PDF"}, {"label": "Excel", "value": "Excel"}, {"label": "CSV", "value": "CSV"}]}
  ]',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
),
(
  'template-analytics-001',
  'User Activity Analysis',
  'Detailed breakdown of user engagement and activity metrics',
  'analytics',
  'users',
  '[
    {"name": "startDate", "type": "date", "label": "Start Date", "required": true},
    {"name": "endDate", "type": "date", "label": "End Date", "required": true},
    {"name": "userType", "type": "select", "label": "User Type", "required": false, "options": [{"label": "All Users", "value": "all"}, {"label": "Customers", "value": "customer"}, {"label": "Suppliers", "value": "supplier"}]},
    {"name": "format", "type": "select", "label": "Format", "required": true, "default": "PDF", "options": [{"label": "PDF", "value": "PDF"}, {"label": "Excel", "value": "Excel"}, {"label": "CSV", "value": "CSV"}]}
  ]',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
),
(
  'template-operational-001',
  'Booking Performance Report',
  'Analysis of booking trends, conversion rates, and customer satisfaction',
  'operational',
  'chart',
  '[
    {"name": "startDate", "type": "date", "label": "Start Date", "required": true},
    {"name": "endDate", "type": "date", "label": "End Date", "required": true},
    {"name": "region", "type": "select", "label": "Region", "required": false, "options": [{"label": "All Regions", "value": "all"}, {"label": "Bangkok", "value": "BKK"}, {"label": "Chiang Mai", "value": "CNX"}, {"label": "Phuket", "value": "HKT"}]},
    {"name": "format", "type": "select", "label": "Format", "required": true, "default": "PDF", "options": [{"label": "PDF", "value": "PDF"}, {"label": "Excel", "value": "Excel"}, {"label": "CSV", "value": "CSV"}]}
  ]',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
),
(
  'template-compliance-001',
  'Compliance and Safety Report',
  'Overview of safety incidents, compliance metrics, and risk assessment',
  'compliance',
  'shield',
  '[
    {"name": "startDate", "type": "date", "label": "Start Date", "required": true},
    {"name": "endDate", "type": "date", "label": "End Date", "required": true},
    {"name": "includeDetails", "type": "boolean", "label": "Include Detailed Incidents", "required": false, "default": true},
    {"name": "format", "type": "select", "label": "Format", "required": true, "default": "PDF", "options": [{"label": "PDF", "value": "PDF"}, {"label": "Excel", "value": "Excel"}, {"label": "CSV", "value": "CSV"}]}
  ]',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
