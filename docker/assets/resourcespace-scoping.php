<?php
/**
 * Narrows a user's search to the offices their identity provider asserts, by
 * maintaining the per-user filter override ResourceSpace already honours.
 *
 * Included from include/config.php, which defines $n3o_scoping:
 *   ['field' => 'Funding office', 'shared' => 'All',
 *    'offices' => ['<asserted group>' => '<field option>', ...]]
 */

function n3o_scoping_values(array $scoping): array
{
    global $simplesaml_group_attribute;

    $attributes = simplesaml_getattributes();
    $attribute = trim((string) $simplesaml_group_attribute);
    if ($attribute === '' || !isset($attributes[$attribute]) || !is_array($attributes[$attribute])) {
        return [];
    }

    $values = [];
    foreach ($attributes[$attribute] as $asserted) {
        if (is_string($asserted) && isset($scoping['offices'][$asserted])) {
            $values[] = (string) $scoping['offices'][$asserted];
        }
    }
    if ($values === []) {
        return [];
    }

    $values[] = (string) $scoping['shared'];
    $values = array_unique($values);
    sort($values);

    return $values;
}

function n3o_scoping_create_filter(string $name, string $fieldname, array $values)
{
    $field = ps_value(
        'SELECT ref AS value FROM resource_type_field WHERE name = ? OR title = ?',
        ['s', $fieldname, 's', $fieldname],
        0
    );
    if ($field < 1) {
        return false;
    }

    $nodes = [];
    foreach ($values as $value) {
        $node = get_node_id($value, $field);
        if ($node === false) {
            return false;
        }
        $nodes[] = (int) $node;
    }

    $filter = save_filter(0, $name, RS_FILTER_ALL);
    if (!is_int_loose($filter) || $filter < 1) {
        return false;
    }
    save_filter_rule('new', $filter, [[RS_FILTER_NODE_IN, $nodes]]);

    return (int) $filter;
}

function GlobalHookHandleuserref($userref): void
{
    global $n3o_scoping;

    if (!isset($n3o_scoping['field'], $n3o_scoping['shared'], $n3o_scoping['offices'])) {
        return;
    }
    if (!is_int_loose($userref) || $userref < 1) {
        return;
    }
    if (!function_exists('simplesaml_is_authenticated') || !simplesaml_is_authenticated()) {
        return;
    }

    $held = ps_query(
        'SELECT u.search_filter_o_id AS ref, f.name AS name
           FROM user u LEFT JOIN filter f ON f.ref = u.search_filter_o_id
          WHERE u.ref = ?',
        ['i', $userref]
    );
    if ($held === []) {
        return;
    }
    $heldname = (string) $held[0]['name'];

    $values = n3o_scoping_values($n3o_scoping);
    if ($values === []) {
        // Withdrawing the override returns them to their group's, which is the
        // narrower of the two: leaving it would grant an office they have left.
        if (str_starts_with($heldname, 'scope:')) {
            ps_query('UPDATE user SET search_filter_o_id = NULL WHERE ref = ?', ['i', $userref]);
        }
        return;
    }

    $name = 'scope:' . implode(',', $values);
    if ($name === $heldname) {
        return;
    }
    // Truncation would silently point two different scopes at one filter.
    if (strlen($name) > 200) {
        return;
    }

    $filter = ps_value('SELECT ref AS value FROM filter WHERE name = ?', ['s', $name], 0);
    if ($filter < 1) {
        $filter = n3o_scoping_create_filter($name, (string) $n3o_scoping['field'], $values);
        if ($filter === false) {
            return;
        }
    }

    ps_query('UPDATE user SET search_filter_o_id = ? WHERE ref = ?', ['i', $filter, 'i', $userref]);

    // setup_user() read the old value before this hook was reached, so without
    // this the request that establishes the scope does not itself observe it.
    $GLOBALS['usersearchfilter'] = $filter;
}
