BEGIN;
CREATE TABLE IF NOT EXISTS embedded_devices (
 id UUID PRIMARY KEY, intersection_id UUID NOT NULL UNIQUE REFERENCES intersections(id) ON DELETE CASCADE,
 name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120),
 token_hash TEXT NOT NULL UNIQUE, enabled BOOLEAN NOT NULL DEFAULT TRUE,
 boot_id TEXT, last_seen TIMESTAMPTZ, reported JSONB,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS embedded_commands (
 id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 device_id UUID NOT NULL REFERENCES embedded_devices(id) ON DELETE CASCADE,
 red_axis TEXT NOT NULL CHECK(red_axis IN ('north_south','east_west')),
 red_seconds INTEGER NOT NULL CHECK(red_seconds BETWEEN 10 AND 180),
 yellow_seconds INTEGER NOT NULL DEFAULT 3 CHECK(yellow_seconds=3),
 clearance_seconds INTEGER NOT NULL DEFAULT 2 CHECK(clearance_seconds=2),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','offered','started','completed','aborted')),
 request_id UUID NOT NULL UNIQUE,
 actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS embedded_commands_device_idx ON embedded_commands(device_id,id);
COMMIT;
