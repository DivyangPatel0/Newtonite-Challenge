-- Helper function for priority-based sorting in keyset pagination
CREATE OR REPLACE FUNCTION priority_rank(p text) RETURNS integer AS $$
  SELECT CASE p
    WHEN 'critical' THEN 4
    WHEN 'high' THEN 3
    WHEN 'medium' THEN 2
    WHEN 'low' THEN 1
    ELSE 0
  END;
$$ LANGUAGE sql IMMUTABLE;
