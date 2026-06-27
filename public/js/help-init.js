function toggleFAQ(element) {
            const answer = element.nextElementSibling;
            const toggle = element.querySelector('.faq-toggle');
            if (answer.classList.contains('active')) {
                answer.classList.remove('active');
                toggle.textContent = '+';
            } else {
                answer.classList.add('active');
                toggle.textContent = '−';
            }
        }

        function scrollToFAQ(category) {
            const faqItem = document.querySelector('[data-category="' + category + '"]');
            if (faqItem) {
                faqItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
                setTimeout(function() {
                    const answer = faqItem.querySelector('.faq-answer');
                    if (!answer.classList.contains('active')) {
                        faqItem.querySelector('.faq-question').click();
                    }
                }, 400);
            }
        }
