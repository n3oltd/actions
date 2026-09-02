<?php
/**
 * Sets the options of a fixed-list metadata field from the system that owns the
 * vocabulary. Adds only: a value withdrawn upstream stops being offered while
 * resources already carrying it still render.
 *
 * POST with X-N3O-Signature: sha256=<hmac of the raw body, RS_HOOK_SECRET>
 *   {"field": "Partner", "values": ["...", "..."]}
 */

header('Content-Type: application/json');

function refuse(int $status, string $message): never
{
    http_response_code($status);
    echo json_encode(['error' => $message]);
    exit;
}

$secret = getenv('RS_HOOK_SECRET');
if ($secret === false || $secret === '') {
    http_response_code(404);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    refuse(405, 'post only');
}

$body = file_get_contents('php://input');
$offered = (string) ($_SERVER['HTTP_X_N3O_SIGNATURE'] ?? '');
$expected = 'sha256=' . hash_hmac('sha256', $body, $secret);
if (!hash_equals($expected, $offered)) {
    refuse(401, 'signature does not match');
}

$payload = json_decode($body, true);
if (!is_array($payload) || !isset($payload['field']) || !is_array($payload['values'] ?? null)) {
    refuse(400, 'expected field and values');
}

$allowed = array_filter(array_map('trim', explode(',', (string) getenv('RS_HOOK_FIELDS'))));
if (!in_array($payload['field'], $allowed, true)) {
    refuse(403, 'field is not open to this hook');
}

include_once __DIR__ . '/../include/boot.php';

$field = null;
foreach (get_resource_type_fields() as $candidate) {
    if ($candidate['name'] === $payload['field'] || $candidate['title'] === $payload['field']) {
        $field = $candidate;
        break;
    }
}
if ($field === null) {
    refuse(404, 'no such field');
}
if (!in_array((int) $field['type'], $GLOBALS['FIXED_LIST_FIELD_TYPES'], true)) {
    refuse(409, 'field does not hold a list of options');
}

$added = 0;
$existing = 0;
$rejected = [];
foreach ($payload['values'] as $value) {
    $value = trim((string) $value);
    if ($value === '') {
        continue;
    }
    if (get_node_id($value, $field['ref']) !== false) {
        $existing++;
        continue;
    }
    // An empty order_by is what asks set_node to place the option last; zero is
    // taken as a position, leaving every option tied at the top of the list.
    if (set_node(null, $field['ref'], $value, null, '') === false) {
        $rejected[] = $value;
        continue;
    }
    $added++;
}

echo json_encode([
    'field' => $field['name'],
    'added' => $added,
    'existing' => $existing,
    'rejected' => $rejected,
]);
