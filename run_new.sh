#!/bin/bash
# Run only the new-feature tests.   tests/run_new.sh            -> all of them
#                                   tests/run_new.sh quickstart -> just tests/new/quickstart.js
cd "$(dirname "$0")/.." || exit 1
fail=0
for f in tests/new/${1:-*}.js; do node "$f" || fail=1; done
[ $fail = 0 ] && echo -e "\nALL NEW TESTS PASSED" || echo -e "\nSOME NEW TESTS FAILED"
exit $fail
