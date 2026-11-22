-- Local dev seed. Applied by `supabase db reset` after migrations.
insert into public.questions (id, title, prompt, status) values
  ('00000000-0000-4000-8000-000000000001', 'Sum two numbers',
   'Read two space-separated integers from stdin and print their sum.', 'approved');

insert into public.test_cases (question_id, position, input, expected_output, is_hidden) values
  ('00000000-0000-4000-8000-000000000001', 1, E'1 2\n', '3', false),
  ('00000000-0000-4000-8000-000000000001', 2, E'10 20\n', '30', false),
  ('00000000-0000-4000-8000-000000000001', 3, E'-5 5\n', '0', true),
  ('00000000-0000-4000-8000-000000000001', 4, E'1000000 1\n', '1000001', true);
