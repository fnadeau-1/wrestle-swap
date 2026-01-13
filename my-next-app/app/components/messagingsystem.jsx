'use client'

import React, { useState, useEffect, useRef } from 'react';
import { Send, User, ShoppingBag, Package, X } from 'lucide-react';

export default function MessagingSystem() {
  // State for managing conversations and messages
  const [conversations, setConversations] = useState([]);
  const [activeConversation, setActiveConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [userType, setUserType] = useState('buyer'); // 'buyer' or 'seller'
  const [showNewConvoModal, setShowNewConvoModal] = useState(false);
  const [recipientUsername, setRecipientUsername] = useState('');
  const [productName, setProductName] = useState('');
  const [currentUsername, setCurrentUsername] = useState('CurrentUser'); // This should come from your auth system
  const messagesEndRef = useRef(null);

  // Load data from storage when component mounts
  useEffect(() => {
    loadStoredData();
    
    // Check URL parameters for pre-filled conversation
    const urlParams = new URLSearchParams(window.location.search);
    const recipient = urlParams.get('recipient');
    const product = urlParams.get('product');
    
    if (recipient) {
      setRecipientUsername(recipient);
      if (product) {
        setProductName(product);
      }
      setShowNewConvoModal(true);
    }
  }, []);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Function to load conversations and messages from storage
  const loadStoredData = async () => {
    try {
      // Load conversations list
      const conversationsResult = await window.storage.get('conversations');
      if (conversationsResult) {
        const storedConvos = JSON.parse(conversationsResult.value);
        // Filter out conversations older than 30 days
        const validConvos = storedConvos.filter(convo => {
          const daysSinceLastMessage = (Date.now() - convo.lastMessageTime) / (1000 * 60 * 60 * 24);
          return daysSinceLastMessage <= 30;
        });
        setConversations(validConvos);
        
        // Update storage if we filtered out old conversations
        if (validConvos.length !== storedConvos.length) {
          await window.storage.set('conversations', JSON.stringify(validConvos));
        }
      }
    } catch (error) {
      console.log('No stored conversations found, starting fresh');
    }
  };

  // Function to load messages for a specific conversation
  const loadMessages = async (conversationId) => {
    try {
      const messagesResult = await window.storage.get(`messages:${conversationId}`);
      if (messagesResult) {
        const storedMessages = JSON.parse(messagesResult.value);
        // Filter messages older than 30 days
        const validMessages = storedMessages.filter(msg => {
          const daysSinceMessage = (Date.now() - msg.timestamp) / (1000 * 60 * 60 * 24);
          return daysSinceMessage <= 30;
        });
        setMessages(validMessages);
        
        // Update storage if we filtered out old messages
        if (validMessages.length !== storedMessages.length) {
          await window.storage.set(`messages:${conversationId}`, JSON.stringify(validMessages));
        }
      } else {
        setMessages([]);
      }
    } catch (error) {
      console.log('No messages found for this conversation');
      setMessages([]);
    }
  };

  // Function to start a new conversation with validation
  const startNewConversation = async () => {
    if (!recipientUsername.trim()) {
      alert('Please enter a recipient username');
      return;
    }

    // Check if conversation with this user already exists
    const existingConvo = conversations.find(
      convo => 
        (convo.buyerName === recipientUsername || convo.sellerName === recipientUsername) &&
        (convo.productName === productName || !productName)
    );

    if (existingConvo) {
      setActiveConversation(existingConvo);
      loadMessages(existingConvo.id);
      setShowNewConvoModal(false);
      setRecipientUsername('');
      setProductName('');
      return;
    }

    const conversationId = `conv_${Date.now()}`;
    
    const newConvo = {
      id: conversationId,
      buyerName: userType === 'buyer' ? currentUsername : recipientUsername,
      sellerName: userType === 'seller' ? currentUsername : recipientUsername,
      lastMessage: 'New conversation',
      lastMessageTime: Date.now(),
      productName: productName || 'General Inquiry'
    };

    const updatedConvos = [...conversations, newConvo];
    setConversations(updatedConvos);
    
    // Save to storage
    try {
      await window.storage.set('conversations', JSON.stringify(updatedConvos));
    } catch (error) {
      console.error('Error saving conversation:', error);
    }

    setActiveConversation(newConvo);
    setMessages([]);
    setShowNewConvoModal(false);
    setRecipientUsername('');
    setProductName('');
  };

  // Function to send a message
  const sendMessage = async () => {
    if (!newMessage.trim() || !activeConversation) return;

    const message = {
      id: `msg_${Date.now()}`,
      text: newMessage,
      sender: userType,
      timestamp: Date.now(),
      senderName: userType === 'buyer' ? activeConversation.buyerName : activeConversation.sellerName
    };

    const updatedMessages = [...messages, message];
    setMessages(updatedMessages);

    // Save messages to storage
    try {
      await window.storage.set(`messages:${activeConversation.id}`, JSON.stringify(updatedMessages));
      
      // Update conversation's last message
      const updatedConvos = conversations.map(convo => 
        convo.id === activeConversation.id 
          ? { ...convo, lastMessage: newMessage, lastMessageTime: Date.now() }
          : convo
      );
      setConversations(updatedConvos);
      await window.storage.set('conversations', JSON.stringify(updatedConvos));
      
      // Update active conversation
      setActiveConversation({
        ...activeConversation,
        lastMessage: newMessage,
        lastMessageTime: Date.now()
      });
    } catch (error) {
      console.error('Error saving message:', error);
    }

    setNewMessage('');
  };

  // Function to select a conversation
  const selectConversation = (convo) => {
    setActiveConversation(convo);
    loadMessages(convo.id);
  };

  // Auto-scroll helper
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  // Format timestamp to readable date
  const formatDate = (timestamp) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffInDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
    
    if (diffInDays === 0) {
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } else if (diffInDays === 1) {
      return 'Yesterday';
    } else if (diffInDays < 30) {
      return `${diffInDays} days ago`;
    } else {
      return 'Expired';
    }
  };

  return (
    <div className="flex h-screen bg-gray-100">
      {/* Sidebar - Conversations List */}
      <div className="w-80 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <h1 className="text-xl font-bold text-gray-800 mb-3">Messages</h1>
          
          {/* User Type Toggle */}
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => setUserType('buyer')}
              className={`flex-1 py-2 px-3 rounded-lg flex items-center justify-center gap-2 ${
                userType === 'buyer' 
                  ? 'bg-blue-500 text-white' 
                  : 'bg-gray-100 text-gray-700'
              }`}
            >
              <ShoppingBag size={16} />
              Buyer
            </button>
            <button
              onClick={() => setUserType('seller')}
              className={`flex-1 py-2 px-3 rounded-lg flex items-center justify-center gap-2 ${
                userType === 'seller' 
                  ? 'bg-green-500 text-white' 
                  : 'bg-gray-100 text-gray-700'
              }`}
            >
              <Package size={16} />
              Seller
            </button>
          </div>

          <button
            onClick={() => setShowNewConvoModal(true)}
            className="w-full bg-blue-500 text-white py-2 px-4 rounded-lg hover:bg-blue-600 transition"
          >
            + New Conversation
          </button>
        </div>

        {/* Conversations List */}
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 ? (
            <div className="p-4 text-center text-gray-500">
              No conversations yet. Start a new one!
            </div>
          ) : (
            conversations.map((convo) => {
              const daysSinceLastMessage = Math.floor((Date.now() - convo.lastMessageTime) / (1000 * 60 * 60 * 24));
              const isExpiringSoon = daysSinceLastMessage >= 25;
              
              return (
                <div
                  key={convo.id}
                  onClick={() => selectConversation(convo)}
                  className={`p-4 border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${
                    activeConversation?.id === convo.id ? 'bg-blue-50' : ''
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 bg-gradient-to-br from-blue-400 to-purple-400 rounded-full flex items-center justify-center text-white">
                      <User size={20} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-start">
                        <h3 className="font-semibold text-gray-800 truncate">
                          {userType === 'buyer' ? convo.sellerName : convo.buyerName}
                        </h3>
                        <span className="text-xs text-gray-500">
                          {formatDate(convo.lastMessageTime)}
                        </span>
                      </div>
                      <p className="text-sm text-gray-600 truncate">{convo.productName}</p>
                      <p className="text-sm text-gray-500 truncate">{convo.lastMessage}</p>
                      {isExpiringSoon && (
                        <p className="text-xs text-orange-500 mt-1">
                          Expires in {30 - daysSinceLastMessage} days
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {activeConversation ? (
          <>
            {/* Chat Header */}
            <div className="bg-white border-b border-gray-200 p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-gradient-to-br from-green-400 to-blue-400 rounded-full flex items-center justify-center text-white">
                  <User size={20} />
                </div>
                <div>
                  <h2 className="font-semibold text-gray-800">
                    {userType === 'buyer' ? activeConversation.sellerName : activeConversation.buyerName}
                  </h2>
                  <p className="text-sm text-gray-500">{activeConversation.productName}</p>
                </div>
              </div>
            </div>

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-gray-50">
              {messages.map((msg) => {
                const isOwnMessage = msg.sender === userType;
                return (
                  <div
                    key={msg.id}
                    className={`flex ${isOwnMessage ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-xs lg:max-w-md px-4 py-2 rounded-2xl ${
                        isOwnMessage
                          ? 'bg-blue-500 text-white rounded-br-none'
                          : 'bg-white text-gray-800 rounded-bl-none'
                      }`}
                    >
                      <p className="text-sm">{msg.text}</p>
                      <p className={`text-xs mt-1 ${isOwnMessage ? 'text-blue-100' : 'text-gray-500'}`}>
                        {formatDate(msg.timestamp)}
                      </p>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Message Input */}
            <div className="bg-white border-t border-gray-200 p-4">
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && sendMessage()}
                  placeholder="Type a message..."
                  className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={sendMessage}
                  className="bg-blue-500 text-white px-6 py-2 rounded-lg hover:bg-blue-600 transition flex items-center gap-2"
                >
                  <Send size={18} />
                  Send
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            <div className="text-center">
              <User size={64} className="mx-auto mb-4 text-gray-300" />
              <p className="text-lg">Select a conversation or start a new one</p>
            </div>
          </div>
        )}
      </div>

      {/* New Conversation Modal */}
      {showNewConvoModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-gray-800">New Conversation</h2>
              <button
                onClick={() => {
                  setShowNewConvoModal(false);
                  setRecipientUsername('');
                  setProductName('');
                }}
                className="text-gray-500 hover:text-gray-700"
              >
                <X size={24} />
              </button>
            </div>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Recipient Username *
                </label>
                <input
                  type="text"
                  value={recipientUsername}
                  onChange={(e) => setRecipientUsername(e.target.value)}
                  placeholder="Enter username"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Product Name (Optional)
                </label>
                <input
                  type="text"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  placeholder="Enter product name"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              
              <button
                onClick={startNewConversation}
                className="w-full bg-blue-500 text-white py-3 px-4 rounded-lg hover:bg-blue-600 transition font-medium"
              >
                Start Conversation
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}