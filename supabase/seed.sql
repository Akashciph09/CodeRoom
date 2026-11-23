-- Local dev seed. Applied by `supabase db reset` after migrations.
-- A shared library question (no owner: anyone can interview with it, nobody can edit it).
insert into public.questions (id, created_by) values
  ('00000000-0000-4000-8000-000000000001', null);

-- Created as a draft so its tests can be added, then published (published versions are immutable).
insert into public.question_versions (id, question_id, status, title, statement, constraints, starter_code) values
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'draft',
   'Sum two numbers',
   'Read two space-separated integers from stdin and print their sum.',
   E'-10^9 <= a, b <= 10^9\nInput is a single line.',
   jsonb_build_object(
     'python', E'a, b = map(int, input().split())\n# TODO: print the sum\n',
     'javascript', E'const [a, b] = require(''fs'').readFileSync(0, ''utf8'').trim().split('' '').map(Number);\n// TODO: print the sum\n'
   ));

insert into public.test_cases (version_id, position, input, expected_output, is_hidden) values
  ('00000000-0000-4000-8000-0000000000a1', 1, E'1 2\n', '3', false),
  ('00000000-0000-4000-8000-0000000000a1', 2, E'10 20\n', '30', false),
  ('00000000-0000-4000-8000-0000000000a1', 3, E'-5 5\n', '0', true),
  ('00000000-0000-4000-8000-0000000000a1', 4, E'1000000 1\n', '1000001', true);

update public.question_versions
  set status = 'published', version = 1, published_at = now()
  where id = '00000000-0000-4000-8000-0000000000a1';
