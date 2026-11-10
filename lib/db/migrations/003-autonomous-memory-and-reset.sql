-- Migration 003: Rectify "Onboarded" Trap, Reset Test Profiles, & Add Autonomous Memory Columns
BEGIN;

-- 1. Add source & confidence metadata to dynamic_content and suggested_knowledge_items
ALTER TABLE dynamic_content
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS confidence real NOT NULL DEFAULT 1.0;

ALTER TABLE suggested_knowledge_items
  DROP CONSTRAINT IF EXISTS suggested_knowledge_items_source_conversation_id_conversations_phone_number_fk,
  ADD COLUMN IF NOT EXISTS confidence real NOT NULL DEFAULT 0.85,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'autonomous_reflection';

-- 2. Reset test phone number (772196197) and any unprofiled conversations that were indiscriminately marked 'onboarded'
UPDATE conversations
SET onboarding_status = 'new_lead',
    student_type = 'new',
    batch = 'unknown',
    gender = 'unknown',
    exam_year = NULL,
    hometown_district = NULL,
    other_subjects = NULL,
    class_type = 'undecided',
    physical_location = NULL,
    mode = 'bot',
    needs_attention = false,
    escalation_reason = NULL
WHERE right(regexp_replace(phone_number, '\D', '', 'g'), 9) = '772196197';

-- Also reset any conversation marked 'onboarded' where exam_year IS NULL AND class_type = 'undecided'
-- so unprofiled students are never trapped in static non-profiling mode
UPDATE conversations
SET onboarding_status = 'new_lead',
    student_type = 'new'
WHERE onboarding_status = 'onboarded'
  AND exam_year IS NULL
  AND class_type = 'undecided';

COMMIT;
