(function () {
    if (typeof campusBuildings === 'undefined') return;

    const exploreCategories = [
        {
            title: 'Student Records & Administration',
            icon: 'cards_stack',
            items: ['Admin Block / A Block']
        },
        {
            title: 'Study Areas',
            icon: 'book_ribbon',
            items: ['Maths & Computer Science Building',
                'Limpopo Digital Innovation Lab / LDIL',
                'Language Lab 1',
                'Language Lab 2',
                'Language Lab 3',
                'Library',
                'Old Library',
                'New Library']
        },
        {
            title: 'Graduation Halls',
            icon: 'school',
            items: ['Tiro Hall']
        },
        {
            title: 'Financial Services',
            icon: 'finance',
            items: ['S Block']
        },
        {
            title: 'Student Representative Council',
            icon: 'groups',
            items: ['SRC Chambers']
        },
        {
            title: 'Food & Dining',
            icon: 'restaurant',
            items: ['Tsalas Cafe', 'Madiba Height Restaurant']
        },
        {
            title: 'Sports & Recreation',
            icon: 'sports_and_outdoors',
            items: ['Gym', 'Chess Club', 'Boxing Club']
        },
                {
            title: 'Gateways & Entrances',
            icon: 'door_open',
            items: ['Gate TwO', 'Gate 3']
        }
    ];

    const exploreContent = document.getElementById('exploreContent');
    const placesContent = document.getElementById('placesContent');
    const exploreCategoriesEl = document.getElementById('exploreCategories');
    const exploreDetailsEl = document.getElementById('exploreDetails');
    const navTabs = Array.from(document.querySelectorAll('.nav-tab'));
    const exploreTab = navTabs.find((tab) => tab.getAttribute('data-view') === 'explore');
    const placesTab = navTabs.find((tab) => tab.getAttribute('data-view') === 'places');

    if (!exploreContent || !placesContent || !exploreCategoriesEl || !exploreDetailsEl) return;

    function normalizeSearchText(value) {
        return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    }

    function findBuildingByName(name) {
        const normalizedName = normalizeSearchText(name);
        if (!normalizedName) return null;
        return campusBuildings.find((building) => normalizeSearchText(building.name).includes(normalizedName)) || null;
    }

    function selectExplorePlace(name) {
        const match = findBuildingByName(name);
        if (!match) return;

        const searchInput = document.getElementById('searchInput');
        const suggestionsDropdown = document.getElementById('suggestionsDropdown');

        if (searchInput) {
            searchInput.value = match.name;
            searchInput.focus();
        }

        if (typeof window.showSuggestions === 'function' && typeof window.getSuggestions === 'function') {
            window.showSuggestions(window.getSuggestions(match.name));
        } else if (suggestionsDropdown) {
            suggestionsDropdown.classList.add('show');
        }

        if (typeof window.setDestination === 'function') {
            window.setDestination({ lat: match.lat, lng: match.lng, name: match.name });
        }

        activateNavTab('places');
    }

    function showCategoriesView() {
        exploreCategoriesEl.style.display = 'flex';
        exploreDetailsEl.style.display = 'none';
        exploreDetailsEl.innerHTML = '';
        renderCategories();
    }

    function renderCategories() {
        exploreCategoriesEl.innerHTML = '';
        exploreCategories.forEach((category) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'explore-category-card';
            button.innerHTML = `
                <span class="icon icon-sm">${category.icon}</span>
                <span class="explore-category-title">${category.title}</span>
            `;
            button.addEventListener('click', () => renderCategoryDetails(category));
            exploreCategoriesEl.appendChild(button);
        });
    }

    function renderCategoryDetails(category) {
        exploreCategoriesEl.style.display = 'none';
        exploreDetailsEl.style.display = 'flex';
        exploreDetailsEl.innerHTML = `
            <div class="explore-details-head">
                <button class="explore-back-btn" type="button" id="exploreBackBtn" aria-label="Back to categories">
                    <span class="icon icon-sm">arrow_back</span>
                </button>
                <div style="flex:1;">
                    <div class="explore-details-title">${category.title}</div>
                    <div class="explore-details-sub">${category.items.length} places</div>
                </div>
            </div>
            <div class="explore-dest-list">
                ${category.items.map((item) => `
                    <button class="explore-place-item" type="button" data-name="${item}">
                        <span class="explore-place-name">${item}</span>
                        <span class="explore-place-meta">Tap to visit</span>
                    </button>
                `).join('')}
            </div>
        `;

        const backButton = document.getElementById('exploreBackBtn');
        if (backButton) {
            backButton.addEventListener('click', () => {
                showCategoriesView();
            });
        }

        // Ensure the destination list uses a vertical flex layout with a gap
        const destList = exploreDetailsEl.querySelector('.explore-dest-list');
        if (destList) {
            destList.style.display = 'flex';
            destList.style.flexDirection = 'column';
            destList.style.gap = '10px';
            destList.style.marginTop = '8px';
        }

        exploreDetailsEl.querySelectorAll('.explore-place-item').forEach((button) => {
            button.addEventListener('click', () => selectExplorePlace(button.dataset.name));
        });
    }

    function activateNavTab(tabName) {
        navTabs.forEach((tab) => tab.classList.remove('active'));

        if (tabName === 'explore') {
            if (exploreTab) exploreTab.classList.add('active');
            exploreContent.style.display = 'block';
            placesContent.style.display = 'none';
        } else {
            if (placesTab) placesTab.classList.add('active');
            exploreContent.style.display = 'none';
            placesContent.style.display = 'block';
        }
    }

    if (exploreTab) {
        exploreTab.addEventListener('click', () => activateNavTab('explore'));
    }
    if (placesTab) {
        placesTab.addEventListener('click', () => activateNavTab('places'));
    }

    showCategoriesView();
    activateNavTab('places');
})();
