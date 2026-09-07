-- Migration 005: add program_description to hosted_programs
--
-- Allows hosted shared programs to record their program description
-- alongside name, support identity, channels, and configuration.

alter table hosted_programs add column if not exists program_description text;
