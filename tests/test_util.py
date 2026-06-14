from app.util import ext_of, is_comic, is_image, natural_sort_key


def test_natural_sort_orders_numbers_numerically():
    names = ["page10.jpg", "page2.jpg", "page1.jpg", "page20.jpg"]
    ordered = sorted(names, key=natural_sort_key)
    assert ordered == ["page1.jpg", "page2.jpg", "page10.jpg", "page20.jpg"]


def test_natural_sort_is_case_insensitive():
    assert sorted(["B", "a", "C"], key=natural_sort_key) == ["a", "B", "C"]


def test_natural_sort_mixes_numeric_and_alpha_without_error():
    # Regression: a list with both digit-led and letter-led names must not raise
    # (int vs str comparison) and numbers sort before letters.
    names = ["Batman", "100 Bullets", "9 Lives", "Archie", "300"]
    ordered = sorted(names, key=natural_sort_key)
    assert ordered == ["9 Lives", "100 Bullets", "300", "Archie", "Batman"]


def test_ext_of():
    assert ext_of("X.CBZ") == "cbz"
    assert ext_of("no_ext") == ""
    assert ext_of("a.b.JPG") == "jpg"


def test_is_comic_case_insensitive():
    assert is_comic("foo.CBR")
    assert is_comic("foo.cbz")
    assert is_comic("foo.pdf")
    assert not is_comic("foo.txt")


def test_is_image():
    assert is_image("p.webp")
    assert not is_image("ComicInfo.xml")
