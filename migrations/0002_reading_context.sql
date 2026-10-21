-- Log the settings in force and the outside temperature with every reading, so the chart can
-- show the band as it was at the time. Older rows stay NULL: their settings were not recorded.

ALTER TABLE heating_readings ADD COLUMN target_c REAL;
ALTER TABLE heating_readings ADD COLUMN band_c REAL;
ALTER TABLE heating_readings ADD COLUMN outside_c REAL;  -- tado° weather for the home's location
