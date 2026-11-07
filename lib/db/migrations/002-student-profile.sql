-- Phase 1: permanent student profile on conversations (phone_number is already the PK).
DO $$ BEGIN CREATE TYPE student_gender AS ENUM ('male','female','unknown'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE student_class_type AS ENUM ('online','physical','undecided'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE student_physical_location AS ENUM ('matara_sipyana','tangalle_maarga','galle_ics'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE student_onboarding_status AS ENUM ('new_lead','profiling','payment_pending','onboarded'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS gender student_gender NOT NULL DEFAULT 'unknown';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS exam_year integer;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS hometown_district varchar(100);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS other_subjects varchar(200);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS class_type student_class_type NOT NULL DEFAULT 'undecided';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS physical_location student_physical_location;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS onboarding_status student_onboarding_status NOT NULL DEFAULT 'new_lead';

-- Safe backfills from data we already hold.
UPDATE conversations SET exam_year = batch::text::integer WHERE exam_year IS NULL AND batch IN ('2027','2028');
UPDATE conversations SET onboarding_status = 'onboarded' WHERE student_type = 'existing' AND onboarding_status = 'new_lead';
