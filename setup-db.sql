-- 待辦事項
CREATE TABLE IF NOT EXISTS xlan_todos (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  text text NOT NULL,
  done boolean DEFAULT false,
  source_group text,
  source_message text,
  created_at timestamptz DEFAULT now(),
  done_at timestamptz
);

-- 對話記錄
CREATE TABLE IF NOT EXISTS xlan_conversations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id text NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- 記帳
CREATE TABLE IF NOT EXISTS xlan_expenses (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  amount integer NOT NULL,
  category text NOT NULL,
  note text,
  type text NOT NULL DEFAULT 'expense',
  created_at timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE xlan_todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE xlan_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE xlan_expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "anon_all_todos" ON xlan_todos FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "anon_all_conversations" ON xlan_conversations FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "anon_all_expenses" ON xlan_expenses FOR ALL USING (true) WITH CHECK (true);
