from seatbot.crypto import encrypt_login_field, verify_param


def test_encrypt_is_stable():
    assert encrypt_login_field("123456") == encrypt_login_field("123456")
    assert encrypt_login_field("123456") != "123456"


def test_verify_param_is_order_independent():
    a = {"b": "2", "a": "1"}
    b = {"a": "1", "b": "2"}
    assert verify_param(a, "x") == verify_param(b, "x")
