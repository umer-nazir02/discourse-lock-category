import { apiInitializer } from "discourse/lib/api";

const PLUGIN_ID = "locked-categories";

export default apiInitializer("1.0", (api) => {
  /**
   * Normalize user-entered URLs. If the user enters "hobbydb.com" or "www.hobbydb.com",
   * prefix it with "https://" so the browser doesn't treat it as a relative URL.
   */
  function normalizeUrl(url) {
    if (!url) return "";
    url = url.trim();
    if (
      !url.startsWith("http://") &&
      !url.startsWith("https://") &&
      !url.startsWith("/")
    ) {
      return `https://${url}`;
    }
    return url;
  }

  /**
   * Parse settings values safely whether Discourse delivers them as a JSON
   * string, array, or pipe/comma-separated string.
   */
  function parseSettingValue(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    if (typeof val === "string") {
      val = val.trim();
      if (val.startsWith("[") || val.startsWith("{")) {
        try {
          return JSON.parse(val);
        } catch (e) {}
      }
      return val
        .split(/[|,]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    return [val];
  }

  function getRules() {
    return parseSettingValue(settings.locked_category_rules);
  }

  function extractCategoryIds(raw) {
    const list = parseSettingValue(raw);
    const results = [];
    for (const item of list) {
      if (typeof item === "number") {
        results.push(item);
      } else if (typeof item === "string") {
        const num = parseInt(item, 10);
        results.push(isNaN(num) ? item : num);
      } else if (item && item.id) {
        results.push(item.id);
      }
    }
    return results;
  }

  function extractGroupList(raw) {
    const list = parseSettingValue(raw);
    const results = [];
    for (const item of list) {
      if (typeof item === "number") {
        results.push(item);
      } else if (typeof item === "string") {
        results.push(item.toLowerCase());
      } else if (item && item.name) {
        results.push(item.name.toLowerCase());
      } else if (item && item.id) {
        results.push(item.id);
      }
    }
    return results;
  }

  /**
   * Check whether the current user belongs to any allowed group for a rule.
   */
  function isUserInAllowedGroups(rule) {
    const allowedGroups = extractGroupList(rule.allowed_groups);

    // If allowed_groups is empty, category is locked for everyone
    if (allowedGroups.length === 0) {
      return false;
    }

    const currentUser = api.getCurrentUser();
    if (!currentUser) {
      return false; // Anonymous users are never in any group
    }

    const userGroups = currentUser.groups || [];
    const userGroupIds = userGroups.map((g) => g.id);
    const userGroupNames = userGroups.map((g) => g.name.toLowerCase());

    // Also include special role names if applicable
    if (currentUser.admin) {
      userGroupNames.push("admins", "admin", "staff");
    }
    if (currentUser.moderator) {
      userGroupNames.push("moderators", "moderator", "staff");
    }
    if (currentUser.trust_level !== undefined) {
      userGroupNames.push(`trust_level_${currentUser.trust_level}`);
    }

    for (const group of allowedGroups) {
      if (typeof group === "number" && userGroupIds.includes(group)) {
        return true;
      }
      if (typeof group === "string") {
        const lower = group.toLowerCase();
        const num = parseInt(group, 10);
        if (!isNaN(num) && userGroupIds.includes(num)) {
          return true;
        }
        if (userGroupNames.includes(lower)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Map locked category IDs/slugs to their corresponding rules for users
   * who do NOT pass the group check.
   */
  function buildLockedCategoryMap() {
    const map = new Map();
    const rules = getRules();

    for (const rule of rules) {
      if (!rule || isUserInAllowedGroups(rule)) {
        continue; // User is in an allowed group — do not lock
      }

      const catIds = extractCategoryIds(rule.category_ids);
      for (const id of catIds) {
        map.set(id, rule);
      }
    }

    return map;
  }

  /**
   * Build the CTA button for a locked category. Uses an image URL if
   * configured, otherwise falls back to text. If the image fails to load, the
   * text is shown.
   */
  function createCTAButton(rule) {
    const targetUrl = normalizeUrl(rule.redirect_url);
    const imageUrl = normalizeUrl(rule.button_image_url);

    const button = document.createElement("a");
    button.className = "locked-categories-cta-button";
    button.href = targetUrl;
    button.target = "_blank";
    button.rel = "noopener noreferrer";
    button.title = rule.button_text || "";

    const fallbackText = document.createElement("span");
    fallbackText.className = "cta-fallback-text";
    fallbackText.textContent = rule.button_text || "";

    if (imageUrl) {
      const img = document.createElement("img");
      img.src = imageUrl;
      img.alt = rule.button_text || "";

      img.addEventListener("error", () => {
        img.remove();
        fallbackText.classList.remove("cta-fallback-text");
      });

      button.appendChild(img);
      button.appendChild(fallbackText);
    } else {
      button.textContent = rule.button_text || "";
    }

    button.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      performRedirect(rule.redirect_url, true);
    });

    return button;
  }

  /**
   * Apply blur filter to the ENTIRE category row/box content (title,
   * description, image, subcategories, topic counts). The CTA button overlay is
   * centered over the whole element and stays perfectly sharp.
   */
  function applyCategoryLock(element, rule) {
    if (element.classList.contains("locked-category-processed")) {
      return;
    }
    element.classList.add("locked-category-processed", "locked-category-container");

    // Determine the container that will hold the overlay. For table rows, use
    // the main cell so the overlay covers the visible content.
    let overlayContainer = element;
    if (element.tagName && element.tagName.toLowerCase() === "tr") {
      overlayContainer =
        element.querySelector("td.main-link") ||
        element.querySelector("td.category") ||
        element.querySelector("td:first-child") ||
        element;
      overlayContainer.classList.add("locked-cell-relative");
    }

    // Make sure subcategories exist as a blurred block. If the category has no
    // subcategories, create a placeholder block after the description.
    let subcategoryArea = element.querySelector(".subcategories");
    if (!subcategoryArea) {
      subcategoryArea = document.createElement("div");
      subcategoryArea.className =
        "subcategories locked-category-blur-placeholder";

      const description = element.querySelector(".category-description");
      if (description && description.parentNode) {
        description.insertAdjacentElement("afterend", subcategoryArea);
      } else {
        overlayContainer.appendChild(subcategoryArea);
      }
    }

    // Blur all visible children of the category container EXCEPT the overlay
    // container (we'll append the overlay to it so it stays sharp).
    Array.from(element.children).forEach((child) => {
      if (child !== overlayContainer) {
        child.classList.add("locked-category-blurred-content");
      }
    });

    // Also blur all inner children of the overlay container, so the overlay
    // itself (appended to overlayContainer) remains unblurred.
    Array.from(overlayContainer.children).forEach((child) => {
      if (
        !child.classList.contains("locked-category-shimmer") &&
        !child.classList.contains("locked-category-overlay")
      ) {
        child.classList.add("locked-category-blurred-content");
      }
    });

    // Pad subcategories with placeholder items to keep the area at ~2 rows.
    const realSubcategories = subcategoryArea.querySelectorAll(
      ":scope > :not(.locked-category-shimmer):not(.locked-category-overlay):not(.locked-category-subcategory-placeholder)"
    );
    const minItems = 5;
    if (realSubcategories.length < 4) {
      const placeholdersNeeded = minItems - realSubcategories.length;
      for (let i = 0; i < placeholdersNeeded; i++) {
        const placeholder = document.createElement("div");
        placeholder.className = "locked-category-subcategory-placeholder";
        subcategoryArea.appendChild(placeholder);
      }
    }

    // Add a subtle shimmer overlay to hint that content exists underneath.
    let shimmer = overlayContainer.querySelector(".locked-category-shimmer");
    if (!shimmer) {
      shimmer = document.createElement("div");
      shimmer.className = "locked-category-shimmer";
      overlayContainer.appendChild(shimmer);
    }

    // Create the centered overlay container with the CTA button.
    let overlay = overlayContainer.querySelector(".locked-category-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "locked-category-overlay";
      overlay.appendChild(createCTAButton(rule));
      overlayContainer.appendChild(overlay);
    }

    // Redirect title/description clicks to the locked category URL so users
    // can't navigate into the category itself.
    redirectTitleAndDescription(element, rule);
  }

  /**
   * Lock a topic list row. Instead of blurring the content, we cover the row
   * with a redirect overlay so clicking anywhere on the row opens the locked
   * category URL. The CTA button is shown on top.
   */
  function applyTopicRowLock(row, rule) {
    if (row.classList.contains("locked-category-processed")) {
      return;
    }
    row.classList.add("locked-category-processed", "locked-category-container");

    // Remove any accidental blur classes from previous attempts.
    row
      .querySelectorAll(".locked-category-blurred-content")
      .forEach((el) => el.classList.remove("locked-category-blurred-content"));

    let overlay = row.querySelector(".locked-category-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.className = "locked-category-overlay locked-topic-row-overlay";
      overlay.appendChild(createCTAButton(rule));
      row.appendChild(overlay);
    }

    // Clicking anywhere on the row (except the button) redirects to the lock URL.
    row.addEventListener(
      "click",
      (e) => {
        if (e.target.closest(".locked-categories-cta-button")) {
          return;
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        performRedirect(rule.redirect_url, true);
      },
      true
    );
  }

  /**
   * Replace the default category-page navigation on title/description links
   * inside a locked category row/card with the configured redirect URL.
   */
  function redirectTitleAndDescription(element, rule) {
    const targetUrl = normalizeUrl(rule.redirect_url);
    if (!targetUrl) {
      return;
    }

    const titleEl = element.querySelector(
      "h3, h4, .category-title, .category-name"
    );
    const descriptionEl = element.querySelector(".category-description");

    [titleEl, descriptionEl].forEach((el) => {
      if (!el) {
        return;
      }

      // Find the clickable anchor, if any, inside the element.
      const link = el.tagName.toLowerCase() === "a" ? el : el.querySelector("a");
      if (link) {
        link.href = targetUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.addEventListener(
          "click",
          (e) => {
            e.preventDefault();
            e.stopImmediatePropagation();
            e.stopPropagation();
            performRedirect(rule.redirect_url, true);
          },
          true
        );
      } else {
        // If there's no anchor, make the whole element clickable.
        el.style.cursor = "pointer";
        el.addEventListener(
          "click",
          (e) => {
            e.preventDefault();
            e.stopImmediatePropagation();
            e.stopPropagation();
            performRedirect(rule.redirect_url, true);
          },
          true
        );
      }
    });
  }

  /**
   * Process the home page category selector dropdown (category-drop) so that
   * selecting a locked category redirects to the configured URL instead of
   * navigating to the category page.
   */
  function processCategoryDropdown() {
    const lockedMap = buildLockedCategoryMap();
    if (lockedMap.size === 0) {
      return;
    }

    const site = api.container.lookup("service:site");
    const categories = site?.categories || [];

    // Handle the dropdown header when it currently shows a locked category.
    const dropdowns = document.querySelectorAll(".category-drop");
    dropdowns.forEach((dropdown) => {
      if (dropdown.classList.contains("locked-category-processed")) {
        return;
      }

      const header = dropdown.querySelector(".category-drop-header");
      if (!header) {
        return;
      }

      const selectedName = header.querySelector(".select-kit-selected-name");
      if (!selectedName) {
        return;
      }

      const badge = selectedName.querySelector("[data-category-id]");
      const catId = badge
        ? parseInt(badge.getAttribute("data-category-id"), 10)
        : null;

      if (!catId) {
        return;
      }

      let rule = lockedMap.get(catId);
      if (!rule && site) {
        const catObj = categories.find((c) => c.id === catId);
        if (catObj) {
          rule = lockedMap.get(catObj.slug) || lockedMap.get(catObj.name);
          if (!rule && catObj.parent_category_id) {
            rule = lockedMap.get(catObj.parent_category_id);
          }
        }
      }

      if (rule) {
        redirectCategoryDropdownSelection(dropdown, rule);
      }
    });

    // Use event delegation on the document for dynamically rendered dropdown rows.
    if (!document.body.classList.contains("locked-dropdown-delegation")) {
      document.body.classList.add("locked-dropdown-delegation");
      document.addEventListener(
        "click",
        (e) => {
          const row = e.target.closest(
            ".category-drop .select-kit-row[data-value], .category-drop .select-kit-row[data-category-id]"
          );
          if (!row) {
            return;
          }

          const catIdAttr =
            row.getAttribute("data-category-id") ||
            row.getAttribute("data-value");
          const catId = parseInt(catIdAttr, 10);
          if (!catId) {
            return;
          }

          let rule = lockedMap.get(catId);
          if (!rule && site) {
            const catObj = categories.find((c) => c.id === catId);
            if (catObj) {
              rule = lockedMap.get(catObj.slug) || lockedMap.get(catObj.name);
              if (!rule && catObj.parent_category_id) {
                rule = lockedMap.get(catObj.parent_category_id);
              }
            }
          }

          if (rule) {
            e.preventDefault();
            e.stopImmediatePropagation();
            e.stopPropagation();
            performRedirect(rule.redirect_url, true);
          }
        },
        true
      );
    }
  }

  /**
   * Replace the default behavior of a selected locked category in the dropdown
   * header so clicks redirect to the configured URL.
   */
  function redirectCategoryDropdownSelection(dropdown, rule) {
    if (!dropdown || dropdown.classList.contains("locked-category-processed")) {
      return;
    }
    dropdown.classList.add("locked-category-processed");

    const targetUrl = normalizeUrl(rule.redirect_url);
    if (!targetUrl) {
      return;
    }

    const clickable = dropdown.querySelector(".category-drop-header");
    if (!clickable) {
      return;
    }

    clickable.style.cursor = "pointer";
    clickable.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        performRedirect(rule.redirect_url, true);
      },
      true
    );
  }

  /**
   * Process categories on the categories list page.
   */
  function processCategoriesPage() {
    const lockedMap = buildLockedCategoryMap();
    if (lockedMap.size === 0) {
      return;
    }

    const site = api.container.lookup("service:site");
    const categories = site?.categories || [];

    // Find all category rows / cards in various Discourse layouts
    const selectors = [
      ".category-list tr[data-category-id]",
      ".category-boxes .category-box[data-category-id]",
      ".category-boxes-with-topics .category-box[data-category-id]",
      ".category-list-item[data-category-id]",
    ];

    const elements = document.querySelectorAll(selectors.join(", "));

    elements.forEach((el) => {
      const catIdAttr = el.getAttribute("data-category-id");
      const catId = parseInt(catIdAttr, 10);

      let rule = lockedMap.get(catId);

      // If not directly matched by numeric ID, try matching by category slug
      if (!rule && site) {
        const catObj = categories.find((c) => c.id === catId);
        if (catObj) {
          rule = lockedMap.get(catObj.slug) || lockedMap.get(catObj.name);

          // Also check parent category lock
          if (!rule && catObj.parent_category_id) {
            rule = lockedMap.get(catObj.parent_category_id);
          }
        }
      }

      if (rule) {
        applyCategoryLock(el, rule);
      }
    });
  }

  /**
   * Process topic list rows (e.g. on /latest, /top, or category topic lists)
   * that belong to a locked category.
   */
  function processTopicRows() {
    const lockedMap = buildLockedCategoryMap();
    if (lockedMap.size === 0) {
      return;
    }

    const site = api.container.lookup("service:site");
    const categories = site?.categories || [];

    const topicRows = document.querySelectorAll(
      ".topic-list-item, .latest-topic-list-item, .category-topic-link, tr.topic-list-item, .topic-list-body tr"
    );

    topicRows.forEach((row) => {
      let catId = null;

      // Check badge or data attribute inside topic row
      const badge = row.querySelector(
        "[data-category-id], a.badge-wrapper, .badge-category"
      );
      if (badge) {
        const idAttr = badge.getAttribute("data-category-id");
        if (idAttr) {
          catId = parseInt(idAttr, 10);
        } else {
          const href = badge.getAttribute("href") || "";
          const match = href.match(/\/c\/(?:[^/]+\/)*?(\d+)/);
          if (match) {
            catId = parseInt(match[1], 10);
          } else {
            const slugMatch = href.match(/\/c\/([^/]+)/);
            if (slugMatch && site?.categories) {
              const catObj = site.categories.find(
                (c) =>
                  c.slug === slugMatch[1] ||
                  c.name.toLowerCase() === slugMatch[1].toLowerCase()
              );
              if (catObj) catId = catObj.id;
            }
          }
        }
      }

      // Fallback: check current category context if on a category page
      if (!catId) {
        catId = getCurrentCategoryId(window.location.pathname);
      }

      if (catId) {
        let rule = lockedMap.get(catId);

        if (!rule && site) {
          const catObj = categories.find((c) => c.id === catId);
          if (catObj) {
            rule = lockedMap.get(catObj.slug) || lockedMap.get(catObj.name);
            if (!rule && catObj.parent_category_id) {
              rule = lockedMap.get(catObj.parent_category_id);
            }
          }
        }

        if (rule) {
          applyTopicRowLock(row, rule);
        }
      }
    });
  }

  /**
   * Get the current active category ID from Discourse Ember router or URL.
   */
  function getCurrentCategoryId(url) {
    try {
      const router = api.container.lookup("service:router");
      const currentRoute = router?.currentRoute;
      if (currentRoute) {
        const cat =
          currentRoute.attributes?.category ||
          currentRoute.parent?.attributes?.category;
        if (cat && cat.id) {
          return cat.id;
        }

        const topic =
          currentRoute.attributes?.topic ||
          currentRoute.parent?.attributes?.topic;
        if (topic && topic.category_id) {
          return topic.category_id;
        }
      }
    } catch (e) {}

    // Match /c/slug/123 or /c/parent/child/123
    const catIdMatch = url.match(/\/c\/(?:[^/]+\/)*?(\d+)/);
    if (catIdMatch) {
      return parseInt(catIdMatch[1], 10);
    }

    // Match /c/slug
    const catSlugMatch = url.match(/\/c\/([^/]+)/);
    if (catSlugMatch) {
      const slug = catSlugMatch[1];
      const site = api.container.lookup("service:site");
      if (site && site.categories) {
        const catObj = site.categories.find(
          (c) => c.slug === slug || c.name.toLowerCase() === slug.toLowerCase()
        );
        if (catObj) return catObj.id;
      }
    }

    return null;
  }

  /**
   * Check if current navigation hits a locked category page or topic.
   */
  function checkDirectCategoryNavigation(url) {
    const lockedMap = buildLockedCategoryMap();
    if (lockedMap.size === 0) {
      return;
    }

    const catId = getCurrentCategoryId(url);
    if (!catId) {
      return;
    }

    let rule = lockedMap.get(catId);

    if (!rule) {
      const site = api.container.lookup("service:site");
      if (site && site.categories) {
        const catObj = site.categories.find((c) => c.id === catId);
        if (catObj) {
          rule = lockedMap.get(catObj.slug) || lockedMap.get(catObj.name);

          if (!rule && catObj.parent_category_id) {
            rule = lockedMap.get(catObj.parent_category_id);
          }
        }
      }
    }

    if (rule) {
      // Use replace so the locked category/post URL never appears in history.
      performRedirect(rule.redirect_url, false);
    }
  }

  function performRedirect(url, openInNewTab = false) {
    const targetUrl = normalizeUrl(url);
    if (!targetUrl) return;

    if (openInNewTab) {
      window.open(targetUrl, "_blank", "noopener,noreferrer");
    } else {
      if (
        targetUrl.startsWith("http://") ||
        targetUrl.startsWith("https://")
      ) {
        document.location.replace(targetUrl);
      } else {
        const router = api.container.lookup("service:router");
        if (router && router.transitionTo) {
          router.transitionTo(targetUrl);
        } else {
          window.location.href = targetUrl;
        }
      }
    }
  }

  // ─── Main Hook ──────────────────────────────────────────────────────────────
  api.onPageChange((url) => {
    setTimeout(() => {
      // Direct category or topic navigation check
      if (url.startsWith("/c/") || url.startsWith("/t/")) {
        checkDirectCategoryNavigation(url);
      }

      // Blur processing for categories & topics
      let attempts = 0;
      const maxAttempts = 12;
      const interval = setInterval(() => {
        attempts++;
        const hasElements = document.querySelector(
          ".category-list, .category-boxes, .category-boxes-with-topics, .topic-list, .category-drop"
        );
        if (hasElements || attempts >= maxAttempts) {
          clearInterval(interval);
          processCategoriesPage();
          processTopicRows();
          processCategoryDropdown();
        }
      }, 150);
    }, 100);
  });
});
